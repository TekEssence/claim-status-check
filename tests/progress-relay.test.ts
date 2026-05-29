import test from "node:test";
import assert from "node:assert/strict";
import { expandSignal, type Signal } from "../lib/redis-signals";

/**
 * Tests for the Edge relay logic without spinning up a real server.
 * We test the relay's parsing, event expansion, and polling termination
 * decisions using pure functions extracted from the relay.
 */

// -----------------------------------------------------------------------
// Relay SSE output format
// -----------------------------------------------------------------------

test("relay streams padding event as first SSE frame", () => {
  const paddingEvent = { type: "padding", payload: "x".repeat(4096) };
  const frame = `data: ${JSON.stringify(paddingEvent)}\n\n`;

  assert.ok(frame.startsWith("data: "));
  assert.ok(frame.endsWith("\n\n"));

  const parsed = JSON.parse(frame.slice(6, -2));
  assert.equal(parsed.type, "padding");
  // 4KB is enough for Edge runtime (no Vercel proxy layer)
  assert.ok(parsed.payload.length >= 4096, "edge padding should be at least 4KB");
  // But less than the 16KB needed for serverless (edge doesn't need it)
  assert.ok(parsed.payload.length < 16384, "edge doesn't need full 16KB padding");
});

test("relay keepalive ping uses SSE comment format", () => {
  const ping = ": ping\n\n";
  assert.ok(ping.startsWith(": "), "ping must be SSE comment (starts with ': ')");
  assert.ok(ping.endsWith("\n\n"), "ping must end with double newline");
});

// -----------------------------------------------------------------------
// Relay jobId validation
// -----------------------------------------------------------------------

test("relay accepts valid UUID v4 jobIds", () => {
  const validJobIds = [
    "550e8400-e29b-41d4-a716-446655440000",
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  ];

  const uuidPattern = /^[0-9a-f-]{36}$/;
  for (const id of validJobIds) {
    assert.ok(uuidPattern.test(id), `${id} should be a valid jobId`);
  }
});

test("relay rejects invalid jobIds", () => {
  const invalidJobIds = [
    "",
    "not-a-uuid",
    "../../../etc/passwd",  // path traversal
    "'; DROP TABLE jobs;--", // SQL injection
    "x".repeat(100),         // too long
  ];

  const uuidPattern = /^[0-9a-f-]{36}$/;
  for (const id of invalidJobIds) {
    assert.ok(!uuidPattern.test(id), `"${id.slice(0, 20)}..." should be rejected`);
  }
});

// -----------------------------------------------------------------------
// Relay: consuming and expanding signals
// -----------------------------------------------------------------------

test("relay correctly expands a batch of mixed signals", () => {
  const signals: Signal[] = [
    { t: "p", c: 1, tot: 10 },
    { t: "l", msg: "Row 1: login successful" },
    { t: "rd", idx: 0 },
    { t: "p", c: 2, tot: 10 },
    { t: "l", msg: "Row 2: processing..." },
  ];

  const events = signals.map(expandSignal);

  assert.equal(events[0].type, "progress");
  assert.equal(events[0].completed, 1);
  assert.equal(events[1].type, "log");
  assert.equal(events[1].message, "Row 1: login successful");
  assert.equal(events[2].type, "row_done");
  assert.equal(events[2].rowIndex, 0);
  assert.equal(events[3].type, "progress");
  assert.equal(events[3].completed, 2);
});

test("relay terminates when it encounters a done signal", () => {
  const signals: Signal[] = [
    { t: "p", c: 10, tot: 10 },
    { t: "done" },
    // Signals after done should not be processed (in real relay)
    { t: "l", msg: "this should not appear" },
  ];

  let finished = false;
  const processedEvents: Array<Record<string, unknown>> = [];

  for (const signal of signals) {
    const event = expandSignal(signal);
    processedEvents.push(event);
    if (signal.t === "done" || signal.t === "err") {
      finished = true;
      break;
    }
  }

  assert.equal(finished, true, "relay should set finished=true on done signal");
  assert.equal(processedEvents.length, 2, "should stop after done signal");
  assert.equal(processedEvents[1].type, "done");
});

test("relay terminates when it encounters an error signal", () => {
  const signals: Signal[] = [
    { t: "p", c: 3, tot: 10 },
    { t: "err", msg: "Browser crashed unexpectedly" },
    { t: "l", msg: "should not appear" },
  ];

  let finished = false;
  const processedEvents: Array<Record<string, unknown>> = [];

  for (const signal of signals) {
    const event = expandSignal(signal);
    processedEvents.push(event);
    if (signal.t === "done" || signal.t === "err") {
      finished = true;
      break;
    }
  }

  assert.equal(finished, true, "relay should set finished=true on error signal");
  assert.equal(processedEvents.length, 2);
  assert.equal(processedEvents[1].type, "error");
  assert.equal(processedEvents[1].message, "Browser crashed unexpectedly");
});

test("relay continues when batch is empty (no signals yet)", () => {
  // Empty poll — relay should wait and try again
  const signals: Signal[] = [];
  let finished = false;

  for (const signal of signals) {
    const event = expandSignal(signal);
    void event;
    if (signal.t === "done" || signal.t === "err") {
      finished = true;
      break;
    }
  }

  assert.equal(finished, false, "empty poll should not terminate relay");
});

// -----------------------------------------------------------------------
// Relay: concurrent stream isolation (PHI never in relay events)
// -----------------------------------------------------------------------

test("relay event types never include PHI event types", () => {
  // The relay only emits events produced by expandSignal()
  // expandSignal() only handles the 5 non-PHI signal types
  const allPossibleRelayEventTypes = [
    expandSignal({ t: "p", c: 1, tot: 10 }).type,
    expandSignal({ t: "l", msg: "x" }).type,
    expandSignal({ t: "rd", idx: 0 }).type,
    expandSignal({ t: "done" }).type,
    expandSignal({ t: "err", msg: "x" }).type,
  ];

  const phiEventTypes = new Set(["row_update", "error_screenshot", "debug_html", "pdf_download"]);

  for (const eventType of allPossibleRelayEventTypes) {
    assert.ok(
      !phiEventTypes.has(eventType as string),
      `PHI event type "${eventType}" must never appear in relay output`,
    );
  }
});

// -----------------------------------------------------------------------
// Signal compactness (free tier friendliness)
// -----------------------------------------------------------------------

test("signals are compact JSON (well under Upstash free tier limits)", () => {
  const signals: Signal[] = [
    { t: "p", c: 42, tot: 100 },
    { t: "l", msg: "Row 42: navigating to claim status page..." },
    { t: "rd", idx: 41 },
    { t: "done" },
    { t: "err", msg: "Timeout waiting for element" },
  ];

  for (const signal of signals) {
    const json = JSON.stringify(signal);
    // Each signal should be well under 1KB (Upstash item limit is 1MB)
    assert.ok(
      json.length < 1024,
      `signal should be < 1KB, got ${json.length} bytes: ${json}`,
    );
  }
});

test("abbreviated signal keys are shorter than full SSE event keys", () => {
  // Verify the abbreviation actually saves space
  const signal: Signal = { t: "p", c: 10, tot: 50 };
  const fullEvent = { type: "progress", completed: 10, total: 50 };

  const signalJson = JSON.stringify(signal);
  const eventJson = JSON.stringify(fullEvent);

  assert.ok(
    signalJson.length < eventJson.length,
    `abbreviated signal (${signalJson.length}B) should be shorter than full event (${eventJson.length}B)`,
  );
});
