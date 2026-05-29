import test from "node:test";
import assert from "node:assert/strict";

/**
 * Tests that verify the two-stream frontend design:
 * - Direct SSE stream: ALWAYS updates progress + logs (baseline)
 * - Edge relay stream: provides faster progress updates only (supplementary)
 *
 * The key invariant: the direct stream must be self-sufficient.
 * If the Edge relay fails for any reason, progress and logs MUST still work.
 */

// -----------------------------------------------------------------------
// Simulate the direct SSE handler's event processing
// -----------------------------------------------------------------------

interface ProgressState {
  completed: number;
  total: number;
}

/**
 * Simulates the direct SSE handler logic from page.tsx.
 * Returns the state that would be set after processing all events.
 */
function processDirectStreamEvents(events: Array<Record<string, unknown>>) {
  let currentCompleted = 0;
  let progress: ProgressState = { completed: 0, total: 0 };
  const logs: string[] = [];
  let chunkHasError = false;

  for (const eventData of events) {
    if (eventData.type === "progress") {
      currentCompleted = eventData.completed as number;
      // Direct stream ALWAYS calls setProgress
      progress = { completed: eventData.completed as number, total: eventData.total as number };
    } else if (eventData.type === "log") {
      // Direct stream ALWAYS calls setLogs
      logs.push(eventData.message as string);
    } else if (eventData.type === "error") {
      chunkHasError = true;
    }
    // row_update, error_screenshot, etc. handled separately
  }

  return { currentCompleted, progress, logs, chunkHasError };
}

/**
 * Simulates the Edge relay handler logic from page.tsx.
 * Only handles progress — logs are NOT handled (to avoid duplicates).
 */
function processRelayStreamEvents(events: Array<Record<string, unknown>>) {
  let progress: ProgressState = { completed: 0, total: 0 };
  const logs: string[] = []; // Should remain empty

  for (const ev of events) {
    if (ev.type === "progress") {
      progress = { completed: ev.completed as number, total: ev.total as number };
    }
    // Logs are NOT handled in relay — they come from direct stream only
  }

  return { progress, logs };
}

// -----------------------------------------------------------------------
// Direct stream self-sufficiency (edge relay NOT available)
// -----------------------------------------------------------------------

test("direct stream: progress updates work without Edge relay", () => {
  const events = [
    { type: "progress", completed: 0, total: 5 },
    { type: "log", message: "Starting..." },
    { type: "progress", completed: 1, total: 5 },
    { type: "log", message: "Row 1 done" },
    { type: "progress", completed: 2, total: 5 },
  ];

  const result = processDirectStreamEvents(events);

  assert.equal(result.progress.completed, 2);
  assert.equal(result.progress.total, 5);
  assert.equal(result.currentCompleted, 2);
});

test("direct stream: log updates work without Edge relay", () => {
  const events = [
    { type: "log", message: "Starting..." },
    { type: "log", message: "Row 1: processing" },
    { type: "log", message: "Row 1: login success" },
    { type: "log", message: "Row 1: found matching claim" },
  ];

  const result = processDirectStreamEvents(events);

  assert.equal(result.logs.length, 4);
  assert.equal(result.logs[0], "Starting...");
  assert.equal(result.logs[3], "Row 1: found matching claim");
});

test("direct stream: complete job flow produces all events without relay", () => {
  const events = [
    { type: "progress", completed: 0, total: 3 },
    { type: "log", message: "Starting..." },
    { type: "log", message: "Row 1: processing" },
    { type: "progress", completed: 1, total: 3 },
    { type: "log", message: "Row 2: processing" },
    { type: "progress", completed: 2, total: 3 },
    { type: "log", message: "Row 3: processing" },
    { type: "progress", completed: 3, total: 3 },
  ];

  const result = processDirectStreamEvents(events);

  assert.equal(result.progress.completed, 3);
  assert.equal(result.progress.total, 3);
  assert.equal(result.currentCompleted, 3);
  assert.equal(result.logs.length, 4); // 4 log events
});

// -----------------------------------------------------------------------
// Edge relay: only progress, no logs (deduplication)
// -----------------------------------------------------------------------

test("edge relay: only handles progress events, NOT logs", () => {
  const events = [
    { type: "progress", completed: 1, total: 10 },
    { type: "log", message: "This should be ignored by relay" },
    { type: "progress", completed: 2, total: 10 },
    { type: "log", message: "This too" },
  ];

  const result = processRelayStreamEvents(events);

  // Progress should be updated
  assert.equal(result.progress.completed, 2);
  assert.equal(result.progress.total, 10);

  // Logs should NOT be handled by relay (empty)
  assert.equal(result.logs.length, 0, "relay must NOT handle logs to avoid duplicates");
});

// -----------------------------------------------------------------------
// Both streams: no duplicate state updates for progress
// -----------------------------------------------------------------------

test("both streams: progress from direct + relay converges to correct value", () => {
  // Simulate both streams providing the same progress events
  const events = [
    { type: "progress", completed: 1, total: 5 },
    { type: "progress", completed: 2, total: 5 },
    { type: "progress", completed: 3, total: 5 },
  ];

  const directResult = processDirectStreamEvents(events);
  const relayResult = processRelayStreamEvents(events);

  // Both should arrive at the same final progress
  assert.deepEqual(directResult.progress, relayResult.progress);
  assert.equal(directResult.progress.completed, 3);
});

test("both streams: relay arriving faster doesn't break direct stream's resume logic", () => {
  // Edge relay might deliver progress(3) before direct stream delivers progress(2)
  // currentCompleted is only updated by direct stream for auto-resume

  // Direct stream events (arriving slower due to US→India buffering)
  const directEvents = [
    { type: "progress", completed: 1, total: 5 },
    { type: "progress", completed: 2, total: 5 },
  ];

  // Relay events (arriving faster from Edge)
  const relayEvents = [
    { type: "progress", completed: 1, total: 5 },
    { type: "progress", completed: 2, total: 5 },
    { type: "progress", completed: 3, total: 5 }, // Faster!
  ];

  const directResult = processDirectStreamEvents(directEvents);
  const relayResult = processRelayStreamEvents(relayEvents);

  // Direct stream's currentCompleted should be accurate for auto-resume
  assert.equal(directResult.currentCompleted, 2);

  // Relay shows faster progress in UI (visual only, no resume effect)
  assert.equal(relayResult.progress.completed, 3);
});

// -----------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------

test("direct stream: error event sets chunkHasError flag", () => {
  const events = [
    { type: "log", message: "Starting..." },
    { type: "error", message: "Browser crashed" },
  ];

  const result = processDirectStreamEvents(events);
  assert.equal(result.chunkHasError, true);
  assert.equal(result.logs.length, 1); // log before error still captured
});

test("direct stream: no error events means chunkHasError is false", () => {
  const events = [
    { type: "progress", completed: 5, total: 5 },
    { type: "log", message: "All done" },
  ];

  const result = processDirectStreamEvents(events);
  assert.equal(result.chunkHasError, false);
});

// -----------------------------------------------------------------------
// PHI events: only in direct stream, never in relay
// -----------------------------------------------------------------------

test("direct stream handles PHI events (they never appear in relay)", () => {
  // PHI events only appear in direct stream
  const phiEventTypes = ["row_update", "error_screenshot", "debug_html", "pdf_download"];

  // These should be ignored by processDirectStreamEvents (handled elsewhere)
  // but they should NOT crash the handler
  const events = phiEventTypes.map(type => ({ type, index: 0, data: "test" }));
  const result = processDirectStreamEvents(events);

  // No crashes, no side effects on progress/logs
  assert.equal(result.logs.length, 0);
  assert.equal(result.progress.completed, 0);
});

// -----------------------------------------------------------------------
// Multi-batch: logs accumulate across batches
// -----------------------------------------------------------------------

test("direct stream: logs accumulate across multiple batches (auto-resume)", () => {
  // Batch 1
  const batch1Events = [
    { type: "log", message: "Batch 1: Row 1" },
    { type: "log", message: "Batch 1: Row 2" },
    { type: "progress", completed: 2, total: 5 },
  ];

  // Batch 2 (auto-resume)
  const batch2Events = [
    { type: "log", message: "Batch 2: Row 3" },
    { type: "log", message: "Batch 2: Row 4" },
    { type: "log", message: "Batch 2: Row 5" },
    { type: "progress", completed: 5, total: 5 },
  ];

  // Simulate React state accumulation
  const allLogs: string[] = [];

  const result1 = processDirectStreamEvents(batch1Events);
  allLogs.push(...result1.logs);

  const result2 = processDirectStreamEvents(batch2Events);
  allLogs.push(...result2.logs);

  assert.equal(allLogs.length, 5);
  assert.equal(allLogs[0], "Batch 1: Row 1");
  assert.equal(allLogs[4], "Batch 2: Row 5");
});

// -----------------------------------------------------------------------
// Edge relay failure graceful degradation
// -----------------------------------------------------------------------

test("when relay fails, direct stream alone provides complete UX", () => {
  // Simulate relay producing nothing (e.g. Redis not configured)
  const relayEvents: Array<Record<string, unknown>> = [];
  const relayResult = processRelayStreamEvents(relayEvents);

  // Relay provides nothing
  assert.equal(relayResult.progress.completed, 0);
  assert.equal(relayResult.logs.length, 0);

  // But direct stream handles everything
  const directEvents = [
    { type: "progress", completed: 0, total: 3 },
    { type: "log", message: "Row 1 starting" },
    { type: "progress", completed: 1, total: 3 },
    { type: "log", message: "Row 2 starting" },
    { type: "progress", completed: 2, total: 3 },
    { type: "log", message: "Row 3 starting" },
    { type: "progress", completed: 3, total: 3 },
  ];

  const directResult = processDirectStreamEvents(directEvents);

  // Direct stream alone provides complete UX
  assert.equal(directResult.progress.completed, 3);
  assert.equal(directResult.progress.total, 3);
  assert.equal(directResult.logs.length, 3);
  assert.equal(directResult.currentCompleted, 3);
});

// -----------------------------------------------------------------------
// X-Job-Id header: relay stream lifecycle
// -----------------------------------------------------------------------

test("X-Job-Id header format is valid UUID for relay subscription", () => {
  // Simulate what route.ts generates
  const crypto = require("node:crypto");
  const jobId = crypto.randomUUID();

  // Validate format
  assert.match(jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // Validate the relay URL construction
  const relayUrl = `/api/progress?jobId=${jobId}`;
  assert.ok(relayUrl.includes(jobId));
  assert.ok(relayUrl.startsWith("/api/progress?jobId="));
});
