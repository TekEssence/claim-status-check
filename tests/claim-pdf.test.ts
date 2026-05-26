import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { extractTextFromPdf } from "../lib/claim-pdf";

test("extractTextFromPdf parses parenthesized PDF text", () => {
  const innerContent = "(Hello, Adela Mary Bautista!) Tj\n(0121714100) Tj\n(02/02/2026) Tj\n";
  const compressed = zlib.deflateSync(Buffer.from(innerContent, "binary"));

  const pdfData = Buffer.concat([
    Buffer.from("1 0 obj\n<< /Length 123 /Filter /FlateDecode >>\nstream\n"),
    compressed,
    Buffer.from("\nendstream\nendobj\n")
  ]);

  const extracted = extractTextFromPdf(pdfData);

  assert.match(extracted, /Hello, Adela Mary Bautista!/);
  assert.match(extracted, /0121714100/);
  assert.match(extracted, /02\/02\/2026/);
});

test("extractTextFromPdf parses hex-encoded PDF text", () => {
  // Hex representation of "Hello" is "48656c6c6f"
  const innerContent = "<48656c6c6f> Tj\n";
  const compressed = zlib.deflateSync(Buffer.from(innerContent, "binary"));

  const pdfData = Buffer.concat([
    Buffer.from("1 0 obj\n<< /Filter [/FlateDecode] >>\nstream\n"),
    compressed,
    Buffer.from("\nendstream\nendobj\n")
  ]);

  const extracted = extractTextFromPdf(pdfData);

  assert.match(extracted, /Hello/);
});
