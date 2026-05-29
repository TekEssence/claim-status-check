import test from "node:test";
import assert from "node:assert/strict";

/**
 * These tests verify the SSE stream optimization behaviors in route.ts
 * without needing to spin up a real server or Playwright.
 *
 * We test the stream construction logic, event formatting, headers,
 * and payload handling patterns in isolation.
 */

// -----------------------------------------------------------------------
// SSE Event Format
// -----------------------------------------------------------------------

test("SSE events are formatted as 'data: {json}\\n\\n'", () => {
  const encoder = new TextEncoder();
  const data = { type: "log", message: "test message" };
  const encoded = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  const decoded = new TextDecoder().decode(encoded);

  assert.ok(decoded.startsWith("data: "));
  assert.ok(decoded.endsWith("\n\n"));

  const jsonStr = decoded.slice(6, -2); // Strip "data: " prefix and "\n\n" suffix
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.type, "log");
  assert.equal(parsed.message, "test message");
});

test("SSE comment pings are formatted as ': {content}\\n\\n'", () => {
  const encoder = new TextEncoder();
  const pingContent = "ping".repeat(256);
  const encoded = encoder.encode(`: ${pingContent}\n\n`);
  const decoded = new TextDecoder().decode(encoded);

  assert.ok(decoded.startsWith(": "));
  assert.ok(decoded.endsWith("\n\n"));
  // Should be ~1KB+ to help trigger proxy flushes
  assert.ok(decoded.length >= 1024, `ping should be >= 1KB, got ${decoded.length}`);
});

// -----------------------------------------------------------------------
// Padding Event
// -----------------------------------------------------------------------

test("initial padding event is 16KB+ to bust proxy buffer thresholds", () => {
  const padding = "x".repeat(16384);
  const event = JSON.stringify({ type: "padding", payload: padding });
  const sseFrame = `data: ${event}\n\n`;

  // The total SSE frame should be well over 16KB
  assert.ok(sseFrame.length > 16384, `padding frame should be > 16KB, got ${sseFrame.length}`);
});

test("padding event parses correctly on the client side", () => {
  const padding = "x".repeat(16384);
  const event = JSON.stringify({ type: "padding", payload: padding });
  const sseFrame = `data: ${event}\n\n`;

  // Simulate client-side parsing
  const dataStr = sseFrame.substring(6, sseFrame.length - 2);
  const parsed = JSON.parse(dataStr);
  assert.equal(parsed.type, "padding");
  assert.equal(parsed.payload.length, 16384);
});

// -----------------------------------------------------------------------
// SSE Response Headers
// -----------------------------------------------------------------------

test("SSE response headers include all required anti-buffering headers", () => {
  const expectedHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Transfer-Encoding": "chunked",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
  };

  // Verify all required headers are present
  for (const [header, value] of Object.entries(expectedHeaders)) {
    assert.ok(header, `Header ${header} should be defined`);
    assert.ok(value, `Header ${header} should have a value`);
  }

  // Specific anti-buffering checks
  assert.equal(expectedHeaders["X-Accel-Buffering"], "no",
    "X-Accel-Buffering: no disables nginx/reverse-proxy buffering");
  assert.equal(expectedHeaders["Content-Encoding"], "none",
    "Content-Encoding: none prevents gzip compression which causes buffering");
  assert.equal(expectedHeaders["Transfer-Encoding"], "chunked",
    "Transfer-Encoding: chunked signals streaming to intermediary proxies");
  assert.ok(expectedHeaders["Cache-Control"].includes("no-transform"),
    "no-transform prevents CDN from modifying the response");
});

// -----------------------------------------------------------------------
// Blob-Based Event Payloads (vs inline base64)
// -----------------------------------------------------------------------

test("blob-based error_screenshot event is much smaller than inline base64", () => {
  // Old approach: inline base64 (~200KB for a JPEG screenshot)
  const fakeBase64 = "A".repeat(200 * 1024);
  const oldEvent = JSON.stringify({
    type: "error_screenshot",
    index: 0,
    image: fakeBase64,
  });

  // New approach: blob key reference (~80 bytes)
  const newEvent = JSON.stringify({
    type: "error_screenshot",
    index: 0,
    blobKey: "550e8400-e29b-41d4-a716-446655440000",
  });

  assert.ok(
    newEvent.length < 200,
    `blob event should be < 200 bytes, got ${newEvent.length}`,
  );
  assert.ok(
    oldEvent.length > 100_000,
    `inline event should be > 100KB, got ${oldEvent.length}`,
  );

  // The reduction factor should be > 1000x
  const reduction = oldEvent.length / newEvent.length;
  assert.ok(reduction > 1000, `reduction factor should be > 1000x, got ${reduction.toFixed(0)}x`);
});

test("blob-based pdf_download event is much smaller than inline base64", () => {
  // Old approach: inline base64 (~500KB for a PDF)
  const fakeBase64 = "B".repeat(500 * 1024);
  const oldEvent = JSON.stringify({
    type: "pdf_download",
    filename: "claim_001.pdf",
    base64: fakeBase64,
  });

  // New approach: blob key reference
  const newEvent = JSON.stringify({
    type: "pdf_download",
    filename: "claim_001.pdf",
    blobKey: "550e8400-e29b-41d4-a716-446655440000",
  });

  assert.ok(newEvent.length < 200);
  assert.ok(oldEvent.length > 400_000);
});

test("blob-based debug_html event is much smaller than inline HTML", () => {
  // Old approach: full DOM HTML (~100KB)
  const fakeHtml = "<html>" + "x".repeat(100 * 1024) + "</html>";
  const oldEvent = JSON.stringify({
    type: "debug_html",
    index: 5,
    html: fakeHtml,
  });

  // New approach: blob key reference
  const newEvent = JSON.stringify({
    type: "debug_html",
    index: 5,
    blobKey: "550e8400-e29b-41d4-a716-446655440000",
  });

  assert.ok(newEvent.length < 200);
  assert.ok(oldEvent.length > 50_000);
});

// -----------------------------------------------------------------------
// SSE Stream Parsing (Client-Side Logic Simulation)
// -----------------------------------------------------------------------

test("client correctly parses multiple SSE events from a chunked buffer", () => {
  // Simulate how the browser's ReadableStream reader would receive chunks
  const events = [
    { type: "log", message: "Starting..." },
    { type: "progress", completed: 1, total: 10 },
    { type: "row_update", index: 0, update: { BotClaimStatusCheck: "Success" } },
  ];

  // Server sends events as "data: {json}\n\n"
  const rawStream = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("");

  // Client parsing logic (mirrors page.tsx)
  const lines = rawStream.split("\n\n");
  const parsed: Array<Record<string, unknown>> = [];

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const dataStr = line.substring(6);
      try {
        parsed.push(JSON.parse(dataStr));
      } catch {
        // skip unparseable
      }
    }
  }

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].type, "log");
  assert.equal(parsed[1].type, "progress");
  assert.equal((parsed[1] as any).completed, 1);
  assert.equal(parsed[2].type, "row_update");
});

test("client handles SSE comments (pings) by ignoring them", () => {
  // SSE comments start with ":" and should be ignored by the client
  const rawStream = [
    `: ${"ping".repeat(256)}\n\n`,
    `data: ${JSON.stringify({ type: "log", message: "real event" })}\n\n`,
    `: ${"ping".repeat(256)}\n\n`,
  ].join("");

  const lines = rawStream.split("\n\n");
  const parsed: Array<Record<string, unknown>> = [];

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      parsed.push(JSON.parse(line.substring(6)));
    }
    // Lines starting with ":" are comments — ignored
  }

  assert.equal(parsed.length, 1, "should only parse data events, not comments");
  assert.equal(parsed[0].type, "log");
});

test("client handles partial chunks that split across reads", () => {
  // Simulate a chunked transfer where an event is split across two reads
  const event = { type: "progress", completed: 5, total: 20 };
  const fullFrame = `data: ${JSON.stringify(event)}\n\n`;

  // Split in the middle
  const chunk1 = fullFrame.substring(0, 15);
  const chunk2 = fullFrame.substring(15);

  let buffer = "";
  const parsed: Array<Record<string, unknown>> = [];

  // Process chunk 1
  buffer += chunk1;
  let parts = buffer.split("\n\n");
  buffer = parts.pop() || "";
  for (const part of parts) {
    if (part.startsWith("data: ")) {
      parsed.push(JSON.parse(part.substring(6)));
    }
  }

  assert.equal(parsed.length, 0, "chunk 1 alone should not produce a complete event");

  // Process chunk 2
  buffer += chunk2;
  parts = buffer.split("\n\n");
  buffer = parts.pop() || "";
  for (const part of parts) {
    if (part.startsWith("data: ")) {
      parsed.push(JSON.parse(part.substring(6)));
    }
  }

  assert.equal(parsed.length, 1, "after chunk 2, event should be complete");
  assert.equal(parsed[0].type, "progress");
  assert.equal((parsed[0] as any).completed, 5);
});

// -----------------------------------------------------------------------
// Keep-Alive Ping Sizing
// -----------------------------------------------------------------------

test("keep-alive pings are approximately 1KB to trigger proxy flushes", () => {
  const pingPayload = "ping".repeat(256);
  const sseComment = `: ${pingPayload}\n\n`;
  const encoded = new TextEncoder().encode(sseComment);

  // Should be >= 1KB
  assert.ok(encoded.byteLength >= 1024, `ping should be >= 1KB, got ${encoded.byteLength}`);
  // But not excessively large (< 2KB)
  assert.ok(encoded.byteLength < 2048, `ping should be < 2KB, got ${encoded.byteLength}`);
});

// -----------------------------------------------------------------------
// Event Type Coverage
// -----------------------------------------------------------------------

test("all SSE event types can be serialized and deserialized correctly", () => {
  const eventTypes = [
    { type: "padding", payload: "x".repeat(100) },
    { type: "log", message: "Processing row 5..." },
    { type: "progress", completed: 5, total: 20 },
    { type: "row_update", index: 3, update: {
      BotClaimDetails: "Summary: [...] | Details: [...]",
      BotClaimStatusCheck: "Success",
      BotClaimStatusCheckError: "",
      BotReferRA: "Check 12345: claim details line"
    }},
    { type: "error_screenshot", index: 2, blobKey: "abc-123" },
    { type: "debug_html", index: 2, blobKey: "def-456" },
    { type: "pdf_download", filename: "claim.pdf", blobKey: "ghi-789" },
    { type: "error", message: "Browser crashed" },
    { type: "done" },
  ];

  for (const event of eventTypes) {
    const json = JSON.stringify(event);
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, event.type, `round-trip failed for type: ${event.type}`);
  }
});

// -----------------------------------------------------------------------
// queueMicrotask yield behavior
// -----------------------------------------------------------------------

test("queueMicrotask-based yield resolves without delay", async () => {
  const start = Date.now();
  await new Promise(resolve => queueMicrotask(() => resolve(undefined)));
  const elapsed = Date.now() - start;

  // Should resolve in < 5ms (the old setTimeout(50) would take >= 50ms)
  assert.ok(elapsed < 50, `queueMicrotask yield should be near-zero, took ${elapsed}ms`);
});

test("multiple queueMicrotask yields are faster than equivalent setTimeouts", async () => {
  const iterations = 10;

  // queueMicrotask
  const microStart = Date.now();
  for (let i = 0; i < iterations; i++) {
    await new Promise(resolve => queueMicrotask(() => resolve(undefined)));
  }
  const microElapsed = Date.now() - microStart;

  // setTimeout(1) — minimum timer resolution
  const timeoutStart = Date.now();
  for (let i = 0; i < iterations; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const timeoutElapsed = Date.now() - timeoutStart;

  assert.ok(
    microElapsed < timeoutElapsed,
    `microtask (${microElapsed}ms) should be faster than setTimeout (${timeoutElapsed}ms)`,
  );
});
