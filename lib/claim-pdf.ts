// Polyfill DOM objects that pdf.js expects to exist in browser environments,
// preventing ReferenceErrors when Node.js evaluates the module.
if (typeof global !== "undefined") {
  if (!(global as any).DOMMatrix) (global as any).DOMMatrix = class DOMMatrix {};
  if (!(global as any).Path2D) (global as any).Path2D = class Path2D {};
  if (!(global as any).ImageData) (global as any).ImageData = class ImageData {};
}

/**
 * Extracts raw text content from a PDF Buffer using pdf-parse.
 * This guarantees correct visual top-to-bottom, left-to-right ordering.
 */
export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  const pdfParseModule = require("pdf-parse");
  const pdfParse = typeof pdfParseModule === 'function' ? pdfParseModule : pdfParseModule.default;
  const data = await pdfParse(pdfBuffer);
  return data.text;
}
