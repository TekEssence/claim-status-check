const pdfParse = require("pdf-parse");

/**
 * Extracts raw text content from a PDF Buffer using pdf-parse.
 * This guarantees correct visual top-to-bottom, left-to-right ordering.
 */
export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  const data = await pdfParse(pdfBuffer);
  return data.text;
}
