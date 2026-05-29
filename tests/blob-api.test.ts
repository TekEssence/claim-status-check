import test from "node:test";
import assert from "node:assert/strict";
import { putBlob, getBlob } from "../lib/blob-store";
import { GET } from "../app/api/blob/[key]/route";

// -----------------------------------------------------------------------
// Helper to build a mock Request and params for the route handler
// -----------------------------------------------------------------------

function buildRouteArgs(key: string) {
  const req = new Request(`http://localhost:3000/api/blob/${key}`);
  const params = Promise.resolve({ key });
  return { req, context: { params } };
}

// -----------------------------------------------------------------------
// GET /api/blob/[key]
// -----------------------------------------------------------------------

test("GET /api/blob/[key] returns 404 for a nonexistent key", async () => {
  const { req, context } = buildRouteArgs("nonexistent-key");
  const response = await GET(req, context);

  assert.equal(response.status, 404);
  const body = await response.text();
  assert.ok(body.includes("not found") || body.includes("expired"));
});

test("GET /api/blob/[key] returns stored string blob with correct content type", async () => {
  const key = putBlob("<html><body>debug</body></html>", "text/html");
  const { req, context } = buildRouteArgs(key);

  const response = await GET(req, context);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html");
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const body = await response.text();
  assert.equal(body, "<html><body>debug</body></html>");
});

test("GET /api/blob/[key] returns stored Buffer blob as binary", async () => {
  const pdfContent = Buffer.from("fake-pdf-content-bytes");
  const key = putBlob(pdfContent, "application/pdf");
  const { req, context } = buildRouteArgs(key);

  const response = await GET(req, context);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/pdf");

  const arrayBuffer = await response.arrayBuffer();
  const decoded = Buffer.from(arrayBuffer).toString();
  assert.equal(decoded, "fake-pdf-content-bytes");
});

test("GET /api/blob/[key] returns image/jpeg for screenshot blobs", async () => {
  // Simulate a JPEG screenshot (first 4 bytes are JPEG magic)
  const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(0x00)]);
  const key = putBlob(jpegData, "image/jpeg");
  const { req, context } = buildRouteArgs(key);

  const response = await GET(req, context);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");

  const arrayBuffer = await response.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  // Verify JPEG magic bytes preserved
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
});

test("GET /api/blob/[key] consumes the blob (second fetch returns 404)", async () => {
  const key = putBlob("one-shot-data", "text/plain");

  const { req: req1, context: ctx1 } = buildRouteArgs(key);
  const response1 = await GET(req1, ctx1);
  assert.equal(response1.status, 200);

  const { req: req2, context: ctx2 } = buildRouteArgs(key);
  const response2 = await GET(req2, ctx2);
  assert.equal(response2.status, 404);
});

test("GET /api/blob/[key] returns 404 for expired blobs", async () => {
  const realDateNow = Date.now;
  try {
    const key = putBlob("will-expire-in-route", "text/plain");

    // Fast-forward time past TTL (11 minutes)
    Date.now = () => realDateNow() + 11 * 60 * 1000;

    const { req, context } = buildRouteArgs(key);
    const response = await GET(req, context);

    assert.equal(response.status, 404);
  } finally {
    Date.now = realDateNow;
  }
});

test("GET /api/blob/[key] handles empty string key gracefully", async () => {
  const { req, context } = buildRouteArgs("");
  const response = await GET(req, context);

  // Empty string key should return 400 (missing) or 404 (not found)
  assert.ok(
    response.status === 400 || response.status === 404,
    `expected 400 or 404, got ${response.status}`,
  );
});

// -----------------------------------------------------------------------
// End-to-end: putBlob → GET route → verify content
// -----------------------------------------------------------------------

test("end-to-end: large PDF blob stored and retrieved via route", async () => {
  // 100KB fake PDF
  const largePdf = Buffer.alloc(100 * 1024, 0xab);
  const key = putBlob(largePdf, "application/pdf");
  const { req, context } = buildRouteArgs(key);

  const response = await GET(req, context);
  assert.equal(response.status, 200);

  const arrayBuffer = await response.arrayBuffer();
  assert.equal(arrayBuffer.byteLength, 100 * 1024);

  // Verify content integrity
  const buf = Buffer.from(arrayBuffer);
  assert.equal(buf[0], 0xab);
  assert.equal(buf[buf.length - 1], 0xab);
});

test("end-to-end: large HTML blob stored and retrieved via route", async () => {
  const largeHtml = "<!DOCTYPE html><html>" + "x".repeat(50 * 1024) + "</html>";
  const key = putBlob(largeHtml, "text/html");
  const { req, context } = buildRouteArgs(key);

  const response = await GET(req, context);
  assert.equal(response.status, 200);

  const text = await response.text();
  assert.ok(text.startsWith("<!DOCTYPE html>"));
  assert.ok(text.endsWith("</html>"));
  assert.equal(text.length, largeHtml.length);
});
