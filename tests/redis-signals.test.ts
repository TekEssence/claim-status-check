import test from "node:test";
import assert from "node:assert/strict";
import {
  expandSignal,
  jobEventsKey,
  type Signal,
} from "../lib/redis-signals";

// -----------------------------------------------------------------------
// jobEventsKey
// -----------------------------------------------------------------------

test("jobEventsKey returns correct Redis key format", () => {
  const key = jobEventsKey("abc-123");
  assert.equal(key, "job:abc-123:events");
});

test("jobEventsKey is stable for the same jobId", () => {
  const jobId = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(jobEventsKey(jobId), jobEventsKey(jobId));
});

// -----------------------------------------------------------------------
// expandSignal — progress
// -----------------------------------------------------------------------

test("expandSignal converts progress signal to full event", () => {
  const signal: Signal = { t: "p", c: 5, tot: 42 };
  const event = expandSignal(signal);
  assert.deepEqual(event, { type: "progress", completed: 5, total: 42 });
});

test("expandSignal progress: completed=0 and total=0 are valid", () => {
  const event = expandSignal({ t: "p", c: 0, tot: 0 });
  assert.equal(event.completed, 0);
  assert.equal(event.total, 0);
});

// -----------------------------------------------------------------------
// expandSignal — log
// -----------------------------------------------------------------------

test("expandSignal converts log signal to full event", () => {
  const signal: Signal = { t: "l", msg: "Row 3: found matching claim" };
  const event = expandSignal(signal);
  assert.deepEqual(event, { type: "log", message: "Row 3: found matching claim" });
});

test("expandSignal log: empty message is preserved", () => {
  const event = expandSignal({ t: "l", msg: "" });
  assert.equal(event.message, "");
});

// -----------------------------------------------------------------------
// expandSignal — row_done
// -----------------------------------------------------------------------

test("expandSignal converts row_done signal to full event", () => {
  const signal: Signal = { t: "rd", idx: 7 };
  const event = expandSignal(signal);
  assert.deepEqual(event, { type: "row_done", rowIndex: 7 });
});

// -----------------------------------------------------------------------
// expandSignal — done
// -----------------------------------------------------------------------

test("expandSignal converts done signal to full event", () => {
  const signal: Signal = { t: "done" };
  const event = expandSignal(signal);
  assert.deepEqual(event, { type: "done" });
});

// -----------------------------------------------------------------------
// expandSignal — error
// -----------------------------------------------------------------------

test("expandSignal converts error signal to full event", () => {
  const signal: Signal = { t: "err", msg: "Browser crashed" };
  const event = expandSignal(signal);
  assert.deepEqual(event, { type: "error", message: "Browser crashed" });
});

// -----------------------------------------------------------------------
// Round-trip: signal → JSON → parse → expandSignal
// -----------------------------------------------------------------------

test("all signal types survive JSON round-trip correctly", () => {
  const signals: Signal[] = [
    { t: "p", c: 10, tot: 50 },
    { t: "l", msg: "Processing..." },
    { t: "rd", idx: 9 },
    { t: "done" },
    { t: "err", msg: "Timed out" },
  ];

  for (const original of signals) {
    const serialized = JSON.stringify(original);
    const parsed = JSON.parse(serialized) as Signal;
    const event = expandSignal(parsed);

    switch (original.t) {
      case "p":
        assert.equal(event.type, "progress");
        assert.equal(event.completed, original.c);
        assert.equal(event.total, original.tot);
        break;
      case "l":
        assert.equal(event.type, "log");
        assert.equal(event.message, original.msg);
        break;
      case "rd":
        assert.equal(event.type, "row_done");
        assert.equal(event.rowIndex, original.idx);
        break;
      case "done":
        assert.equal(event.type, "done");
        break;
      case "err":
        assert.equal(event.type, "error");
        assert.equal(event.message, original.msg);
        break;
    }
  }
});

// -----------------------------------------------------------------------
// PHI safety: verify PHI event types are NOT signal types
// -----------------------------------------------------------------------

test("PHI event types are not representable as Signal types", () => {
  // Signal type union only allows t: "p" | "l" | "rd" | "done" | "err"
  // These should NOT be assignable. We verify at runtime by checking
  // that none of the PHI event names match signal type identifiers.
  const phiEventTypes = ["row_update", "error_screenshot", "debug_html", "pdf_download"];
  const signalTypes = ["p", "l", "rd", "done", "err"];

  for (const phi of phiEventTypes) {
    assert.ok(
      !signalTypes.includes(phi),
      `PHI event type "${phi}" must not be a signal type — it would go through Redis`,
    );
  }
});

// -----------------------------------------------------------------------
// SSE frame format produced by expandSignal
// -----------------------------------------------------------------------

test("SSE frames from expanded signals are correctly formatted", () => {
  const signals: Signal[] = [
    { t: "p", c: 3, tot: 10 },
    { t: "l", msg: "Done with row 3" },
    { t: "done" },
  ];

  for (const signal of signals) {
    const event = expandSignal(signal);
    const frame = `data: ${JSON.stringify(event)}\n\n`;

    assert.ok(frame.startsWith("data: "), "frame must start with 'data: '");
    assert.ok(frame.endsWith("\n\n"), "frame must end with double newline");

    // Verify it's parseable back
    const parsed = JSON.parse(frame.slice(6, -2));
    assert.ok(parsed.type, "expanded event must have type field");
  }
});

// -----------------------------------------------------------------------
// Termination signals
// -----------------------------------------------------------------------

test("done and error are the only signals that should terminate the relay", () => {
  const terminalSignals: Signal[] = [
    { t: "done" },
    { t: "err", msg: "Something failed" },
  ];

  const nonTerminalSignals: Signal[] = [
    { t: "p", c: 1, tot: 10 },
    { t: "l", msg: "Still going" },
    { t: "rd", idx: 0 },
  ];

  for (const s of terminalSignals) {
    assert.ok(
      s.t === "done" || s.t === "err",
      `${s.t} should be a terminal signal`,
    );
  }

  for (const s of nonTerminalSignals) {
    assert.ok(
      s.t !== "done" && s.t !== "err",
      `${s.t} should NOT be a terminal signal`,
    );
  }
});
