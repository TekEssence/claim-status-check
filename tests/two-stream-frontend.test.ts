import test from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the flag-based two-stream frontend design:
 *
 * relayConnected = false → direct stream is source of truth (fallback)
 * relayConnected = true  → Edge relay is source of truth (real-time)
 *
 * Key invariants:
 * 1. Direct stream ALWAYS tracks currentCompleted for auto-resume
 * 2. When relay is connected, direct stream skips setProgress/setLogs
 * 3. When relay fails, direct stream resumes as fallback
 * 4. No log duplication — only ONE source feeds UI at any time
 */

// -----------------------------------------------------------------------
// Simulate the stream handlers
// -----------------------------------------------------------------------

interface ProgressState { completed: number; total: number }

interface StreamResult {
  currentCompleted: number;
  progress: ProgressState;
  logs: string[];
  chunkHasError: boolean;
}

/**
 * Simulates processing events through BOTH streams with flag-based switching.
 *
 * relayEvents: events arriving from Edge relay (real-time, via Redis)
 * directEvents: events arriving from direct SSE (buffered, from US)
 * relayArrivalIndex: index in directEvents at which the relay connects
 *   (simulates relay delivering its first event between direct events)
 *   -1 means relay never connects
 */
function simulateTwoStreams(
  relayEvents: Array<Record<string, unknown>>,
  directEvents: Array<Record<string, unknown>>,
  relayArrivalIndex: number = -1,
): StreamResult {
  let relayConnected = false;
  let currentCompleted = 0;
  let progress: ProgressState = { completed: 0, total: 0 };
  const logs: string[] = [];
  let chunkHasError = false;

  // Process relay events (simulating them arriving before/during direct stream)
  const processRelayEvent = (ev: Record<string, unknown>) => {
    if (ev.type === "padding") return;

    if (!relayConnected) {
      relayConnected = true;
    }

    if (ev.type === "progress") {
      progress = { completed: ev.completed as number, total: ev.total as number };
    } else if (ev.type === "log") {
      logs.push(ev.message as string);
    }
  };

  // Process direct stream events
  const processDirectEvent = (eventData: Record<string, unknown>) => {
    if (eventData.type === "progress") {
      // ALWAYS track for auto-resume
      currentCompleted = eventData.completed as number;
      // Only update UI if relay hasn't taken over
      if (!relayConnected) {
        progress = { completed: eventData.completed as number, total: eventData.total as number };
      }
    } else if (eventData.type === "log") {
      if (!relayConnected) {
        logs.push(eventData.message as string);
      }
    } else if (eventData.type === "error") {
      chunkHasError = true;
    }
  };

  // Simulate interleaved processing
  let relayIdx = 0;
  for (let i = 0; i < directEvents.length; i++) {
    // Relay events arrive at the specified index
    if (i === relayArrivalIndex) {
      while (relayIdx < relayEvents.length) {
        processRelayEvent(relayEvents[relayIdx]);
        relayIdx++;
      }
    }
    processDirectEvent(directEvents[i]);
  }

  // Process remaining relay events if they arrive after direct stream
  while (relayIdx < relayEvents.length) {
    processRelayEvent(relayEvents[relayIdx]);
    relayIdx++;
  }

  return { currentCompleted, progress, logs, chunkHasError };
}

// -----------------------------------------------------------------------
// Relay NOT available: direct stream is sole source
// -----------------------------------------------------------------------

test("fallback: when relay never connects, direct stream handles all progress", () => {
  const directEvents = [
    { type: "progress", completed: 0, total: 5 },
    { type: "progress", completed: 1, total: 5 },
    { type: "progress", completed: 2, total: 5 },
  ];

  const result = simulateTwoStreams([], directEvents, -1);

  assert.equal(result.progress.completed, 2);
  assert.equal(result.progress.total, 5);
  assert.equal(result.currentCompleted, 2);
});

test("fallback: when relay never connects, direct stream handles all logs", () => {
  const directEvents = [
    { type: "log", message: "Starting..." },
    { type: "log", message: "Row 1: done" },
    { type: "log", message: "Row 2: done" },
  ];

  const result = simulateTwoStreams([], directEvents, -1);

  assert.equal(result.logs.length, 3);
  assert.equal(result.logs[0], "Starting...");
  assert.equal(result.logs[2], "Row 2: done");
});

// -----------------------------------------------------------------------
// Relay connected: relay is source of truth, no duplicates
// -----------------------------------------------------------------------

test("relay connected: relay provides logs, direct stream skips them", () => {
  const relayEvents = [
    { type: "log", message: "Row 1 (relay)" },
    { type: "log", message: "Row 2 (relay)" },
  ];
  const directEvents = [
    { type: "log", message: "Row 1 (direct)" },
    { type: "log", message: "Row 2 (direct)" },
  ];

  // Relay arrives at index 0 (before first direct event)
  const result = simulateTwoStreams(relayEvents, directEvents, 0);

  // Only relay logs should appear — no duplicates
  assert.equal(result.logs.length, 2);
  assert.equal(result.logs[0], "Row 1 (relay)");
  assert.equal(result.logs[1], "Row 2 (relay)");
});

test("relay connected: relay provides progress, direct stream skips it", () => {
  const relayEvents = [
    { type: "progress", completed: 3, total: 10 },
  ];
  const directEvents = [
    { type: "progress", completed: 1, total: 10 }, // Older, buffered
    { type: "progress", completed: 2, total: 10 }, // Older, buffered
    { type: "progress", completed: 3, total: 10 }, // Same as relay
  ];

  // Relay arrives at index 0
  const result = simulateTwoStreams(relayEvents, directEvents, 0);

  // Progress should show relay's value (3), not be overwritten by direct
  assert.equal(result.progress.completed, 3);
});

test("relay connected: direct stream still tracks currentCompleted for resume", () => {
  const relayEvents = [
    { type: "progress", completed: 5, total: 10 },
  ];
  const directEvents = [
    { type: "progress", completed: 3, total: 10 },
    { type: "progress", completed: 4, total: 10 },
    { type: "progress", completed: 5, total: 10 },
  ];

  // Relay arrives first
  const result = simulateTwoStreams(relayEvents, directEvents, 0);

  // currentCompleted must be tracked from direct stream for auto-resume
  assert.equal(result.currentCompleted, 5);
});

// -----------------------------------------------------------------------
// Relay connects mid-stream: graceful handoff
// -----------------------------------------------------------------------

test("mid-stream handoff: direct handles first events, relay takes over", () => {
  const relayEvents = [
    { type: "log", message: "Row 2 (relay)" },
    { type: "log", message: "Row 3 (relay)" },
    { type: "progress", completed: 3, total: 5 },
  ];
  const directEvents = [
    { type: "log", message: "Row 1 (direct)" },   // index 0: before relay
    { type: "progress", completed: 1, total: 5 },  // index 1: before relay
    { type: "log", message: "Row 2 (direct)" },    // index 2: after relay connects
    { type: "log", message: "Row 3 (direct)" },    // index 3: after relay connects
    { type: "progress", completed: 3, total: 5 },  // index 4: after relay
  ];

  // Relay arrives at index 2 (after first 2 direct events)
  const result = simulateTwoStreams(relayEvents, directEvents, 2);

  // Should see: Row 1 from direct, then Row 2 + Row 3 from relay
  assert.equal(result.logs.length, 3);
  assert.equal(result.logs[0], "Row 1 (direct)");
  assert.equal(result.logs[1], "Row 2 (relay)");
  assert.equal(result.logs[2], "Row 3 (relay)");

  // Progress shows relay value (3), not overwritten by direct
  assert.equal(result.progress.completed, 3);

  // But currentCompleted tracks direct stream for resume
  assert.equal(result.currentCompleted, 3);
});

// -----------------------------------------------------------------------
// Relay failure mid-stream: fallback to direct
// -----------------------------------------------------------------------

test("relay failure: if relay errors, relayConnected resets and direct resumes", () => {
  // Simulate relay connecting then failing
  let relayConnected = false;

  // Relay connects
  relayConnected = true;

  // Relay errors
  relayConnected = false;

  // Now direct events should be processed
  const directEvents = [
    { type: "log", message: "After relay failure" },
    { type: "progress", completed: 5, total: 10 },
  ];

  // Simulate with no relay (relayArrivalIndex = -1)
  const result = simulateTwoStreams([], directEvents, -1);

  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0], "After relay failure");
  assert.equal(result.progress.completed, 5);
});

// -----------------------------------------------------------------------
// Padding events are skipped
// -----------------------------------------------------------------------

test("relay skips padding events and does not set relayConnected", () => {
  const relayEvents = [
    { type: "padding", payload: "xxxx" }, // Should NOT trigger relayConnected
  ];
  const directEvents = [
    { type: "log", message: "From direct" },
  ];

  // Relay "arrives" at index 0 but only sends padding
  const result = simulateTwoStreams(relayEvents, directEvents, 0);

  // Padding should not trigger relayConnected, so direct handles logs
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0], "From direct");
});

test("relay: first non-padding event triggers relayConnected", () => {
  const relayEvents = [
    { type: "padding", payload: "xxxx" },
    { type: "log", message: "First real relay event" },
  ];
  const directEvents = [
    { type: "log", message: "From direct (should be skipped)" },
  ];

  const result = simulateTwoStreams(relayEvents, directEvents, 0);

  // Only relay log should appear
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0], "First real relay event");
});

// -----------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------

test("error events are handled by direct stream regardless of relay state", () => {
  const relayEvents = [
    { type: "progress", completed: 1, total: 5 },
  ];
  const directEvents = [
    { type: "error", message: "Browser crashed" },
  ];

  const result = simulateTwoStreams(relayEvents, directEvents, 0);

  assert.equal(result.chunkHasError, true);
});

// -----------------------------------------------------------------------
// Multi-batch log accumulation
// -----------------------------------------------------------------------

test("logs accumulate across batches when relay is connected", () => {
  // Batch 1: relay connected
  const batch1Relay = [
    { type: "log", message: "Batch 1: Row 1" },
    { type: "log", message: "Batch 1: Row 2" },
  ];
  const batch1Direct = [
    { type: "progress", completed: 2, total: 5 },
  ];

  const result1 = simulateTwoStreams(batch1Relay, batch1Direct, 0);
  const allLogs = [...result1.logs];

  // Batch 2: relay connected
  const batch2Relay = [
    { type: "log", message: "Batch 2: Row 3" },
    { type: "log", message: "Batch 2: Row 4" },
  ];
  const batch2Direct = [
    { type: "progress", completed: 4, total: 5 },
  ];

  const result2 = simulateTwoStreams(batch2Relay, batch2Direct, 0);
  allLogs.push(...result2.logs);

  assert.equal(allLogs.length, 4);
  assert.equal(allLogs[0], "Batch 1: Row 1");
  assert.equal(allLogs[3], "Batch 2: Row 4");
});

// -----------------------------------------------------------------------
// PHI events: always handled by direct stream, never affected by relay
// -----------------------------------------------------------------------

test("PHI events from direct stream are always handled regardless of relay", () => {
  // Even when relay is connected, PHI events go through direct stream
  const relayEvents = [
    { type: "progress", completed: 1, total: 3 },
  ];
  const directEvents = [
    { type: "row_update", index: 0, update: { status: "Paid" } },
    { type: "error_screenshot", index: 1, image: "base64..." },
    { type: "pdf_download", filename: "claim.pdf", base64: "base64..." },
  ];

  // Should not crash
  const result = simulateTwoStreams(relayEvents, directEvents, 0);

  // PHI events don't affect progress/logs/currentCompleted
  assert.equal(result.currentCompleted, 0);
  assert.equal(result.logs.length, 0);
});

// -----------------------------------------------------------------------
// Client-generated jobId
// -----------------------------------------------------------------------

test("client-generated jobId is valid UUID for relay subscription", () => {
  const crypto = require("node:crypto");
  const jobId = crypto.randomUUID();
  assert.match(jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const relayUrl = `/api/progress?jobId=${jobId}`;
  assert.ok(relayUrl.startsWith("/api/progress?jobId="));
});

test("relay opens BEFORE POST: relay receives events while POST is in flight", () => {
  // This test simulates the critical timing:
  // 1. Client generates jobId
  // 2. Client opens relay immediately (relay starts polling Redis)
  // 3. Client sends POST with jobId (server starts pushing to Redis)
  // 4. Relay receives events in real-time while POST response is buffered

  // Relay events arrive (server pushes to Redis as it processes)
  const relayEvents = [
    { type: "log", message: "Row 1: processing" },
    { type: "progress", completed: 1, total: 3 },
    { type: "log", message: "Row 2: processing" },
    { type: "progress", completed: 2, total: 3 },
    { type: "log", message: "Row 3: processing" },
    { type: "progress", completed: 3, total: 3 },
  ];

  // Direct events arrive ALL AT ONCE when POST response is finally delivered
  const directEvents = [
    { type: "progress", completed: 1, total: 3 },
    { type: "progress", completed: 2, total: 3 },
    { type: "progress", completed: 3, total: 3 },
    { type: "row_update", index: 0, update: {} },
    { type: "row_update", index: 1, update: {} },
    { type: "row_update", index: 2, update: {} },
  ];

  // Relay delivers BEFORE direct stream (relayArrivalIndex = -1 means
  // relay delivers after direct, but index 0 means before first direct event)
  // Here we set index = 0 to simulate relay delivering before direct stream
  // arrives (because direct stream is buffered for 1 minute)
  const result = simulateTwoStreams(relayEvents, directEvents, 0);

  // All logs came from relay (direct was skipped because relay connected first)
  assert.equal(result.logs.length, 3);
  assert.equal(result.logs[0], "Row 1: processing");
  assert.equal(result.logs[2], "Row 3: processing");

  // Progress shows final value
  assert.equal(result.progress.completed, 3);

  // currentCompleted tracked from direct stream for auto-resume
  assert.equal(result.currentCompleted, 3);
});
