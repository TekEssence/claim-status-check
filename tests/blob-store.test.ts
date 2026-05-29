import test from "node:test";
import assert from "node:assert/strict";
import { putBlob, getBlob, peekBlob } from "../lib/blob-store";

// -----------------------------------------------------------------------
// putBlob
// -----------------------------------------------------------------------

test("putBlob stores a string and returns a UUID key", () => {
  const key = putBlob("hello world", "text/plain");

  assert.ok(key, "key should be truthy");
  // UUID v4 format: 8-4-4-4-12 hex chars
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("putBlob stores a Buffer and returns a UUID key", () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
  const key = putBlob(buf, "image/png");

  assert.ok(key);
  assert.match(key, /^[0-9a-f]{8}-/);
});

test("putBlob returns unique keys for each call", () => {
  const key1 = putBlob("data-1", "text/plain");
  const key2 = putBlob("data-2", "text/plain");

  assert.notEqual(key1, key2);
});

// -----------------------------------------------------------------------
// getBlob
// -----------------------------------------------------------------------

test("getBlob retrieves a previously stored string blob", () => {
  const key = putBlob("<html>test</html>", "text/html");
  const result = getBlob(key);

  assert.ok(result);
  assert.equal(result.data, "<html>test</html>");
  assert.equal(result.contentType, "text/html");
});

test("getBlob retrieves a previously stored Buffer blob", () => {
  const buf = Buffer.from("PDF content here");
  const key = putBlob(buf, "application/pdf");
  const result = getBlob(key);

  assert.ok(result);
  assert.ok(Buffer.isBuffer(result.data));
  assert.equal(result.data.toString(), "PDF content here");
  assert.equal(result.contentType, "application/pdf");
});

test("getBlob returns null for a nonexistent key", () => {
  const result = getBlob("nonexistent-key-12345");

  assert.equal(result, null);
});

test("getBlob deletes the blob after retrieval (one-time fetch)", () => {
  const key = putBlob("one-time-data", "text/plain");

  const first = getBlob(key);
  assert.ok(first, "first fetch should succeed");

  const second = getBlob(key);
  assert.equal(second, null, "second fetch should return null (deleted)");
});

test("getBlob returns null for an expired blob", () => {
  // We can't easily wait 10 minutes, so we test the expiry logic by
  // directly manipulating the store. Instead, we use a workaround:
  // putBlob stores with expiresAt = Date.now() + TTL_MS. We can stub
  // Date.now to simulate expiry.
  const realDateNow = Date.now;
  try {
    const key = putBlob("will-expire", "text/plain");

    // Fast-forward time by 11 minutes
    Date.now = () => realDateNow() + 11 * 60 * 1000;

    const result = getBlob(key);
    assert.equal(result, null, "should return null for expired blob");
  } finally {
    Date.now = realDateNow;
  }
});

test("getBlob returns the blob if NOT yet expired", () => {
  const realDateNow = Date.now;
  try {
    const key = putBlob("still-valid", "text/plain");

    // Fast-forward only 5 minutes (TTL is 10 minutes)
    Date.now = () => realDateNow() + 5 * 60 * 1000;

    const result = getBlob(key);
    assert.ok(result, "should return the blob within TTL");
    assert.equal(result.data, "still-valid");
  } finally {
    Date.now = realDateNow;
  }
});

// -----------------------------------------------------------------------
// peekBlob
// -----------------------------------------------------------------------

test("peekBlob retrieves without deleting the blob", () => {
  const key = putBlob("peek-data", "text/plain");

  const first = peekBlob(key);
  assert.ok(first);
  assert.equal(first.data, "peek-data");
  assert.equal(first.contentType, "text/plain");

  const second = peekBlob(key);
  assert.ok(second, "peekBlob should NOT delete — second call should succeed");
  assert.equal(second.data, "peek-data");
});

test("peekBlob returns null for a nonexistent key", () => {
  const result = peekBlob("does-not-exist");
  assert.equal(result, null);
});

test("peekBlob returns null for an expired blob and cleans it up", () => {
  const realDateNow = Date.now;
  try {
    const key = putBlob("peek-expired", "text/plain");

    Date.now = () => realDateNow() + 11 * 60 * 1000;

    const result = peekBlob(key);
    assert.equal(result, null, "should return null for expired blob");

    // Restore time — blob should still be gone (cleaned up by peekBlob)
    Date.now = realDateNow;
    const afterCleanup = peekBlob(key);
    assert.equal(afterCleanup, null, "blob should be deleted after expiry check");
  } finally {
    Date.now = realDateNow;
  }
});

// -----------------------------------------------------------------------
// Interaction between getBlob and peekBlob
// -----------------------------------------------------------------------

test("peekBlob works after peekBlob, but getBlob consumes the blob", () => {
  const key = putBlob("interaction-test", "text/plain");

  // peekBlob should not consume
  const peek1 = peekBlob(key);
  assert.ok(peek1);

  const peek2 = peekBlob(key);
  assert.ok(peek2);

  // getBlob should consume
  const get1 = getBlob(key);
  assert.ok(get1);

  // Now both should return null
  const peek3 = peekBlob(key);
  assert.equal(peek3, null);

  const get2 = getBlob(key);
  assert.equal(get2, null);
});

// -----------------------------------------------------------------------
// Large payload handling
// -----------------------------------------------------------------------

test("putBlob and getBlob handle large payloads (simulating screenshots/PDFs)", () => {
  // 500KB buffer simulating a JPEG screenshot
  const largeBuffer = Buffer.alloc(500 * 1024, 0xff);
  const key = putBlob(largeBuffer, "image/jpeg");
  const result = getBlob(key);

  assert.ok(result);
  assert.equal(result.contentType, "image/jpeg");
  assert.ok(Buffer.isBuffer(result.data));
  assert.equal((result.data as Buffer).length, 500 * 1024);
});

test("putBlob and getBlob handle large string payloads (simulating debug HTML)", () => {
  // 200KB HTML string
  const largeHtml = "<html>" + "x".repeat(200 * 1024) + "</html>";
  const key = putBlob(largeHtml, "text/html");
  const result = getBlob(key);

  assert.ok(result);
  assert.equal(result.contentType, "text/html");
  assert.equal(typeof result.data, "string");
  assert.ok((result.data as string).startsWith("<html>"));
  assert.ok((result.data as string).endsWith("</html>"));
});

// -----------------------------------------------------------------------
// Multiple blobs in parallel
// -----------------------------------------------------------------------

test("multiple blobs can coexist and be retrieved independently", () => {
  const key1 = putBlob("blob-1", "text/plain");
  const key2 = putBlob(Buffer.from("blob-2"), "application/octet-stream");
  const key3 = putBlob("<p>blob-3</p>", "text/html");

  // Retrieve in reverse order
  const result3 = getBlob(key3);
  assert.ok(result3);
  assert.equal(result3.data, "<p>blob-3</p>");

  const result1 = getBlob(key1);
  assert.ok(result1);
  assert.equal(result1.data, "blob-1");

  const result2 = getBlob(key2);
  assert.ok(result2);
  assert.equal((result2.data as Buffer).toString(), "blob-2");

  // All consumed
  assert.equal(getBlob(key1), null);
  assert.equal(getBlob(key2), null);
  assert.equal(getBlob(key3), null);
});
