import { extractText } from 'unpdf';

/**
 * Extracts raw text content from a PDF Buffer using unpdf.
 * This guarantees correct visual top-to-bottom, left-to-right ordering
 * and avoids DOM/Canvas polyfill issues in Next.js Server environments.
 */
export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  const uint8Array = new Uint8Array(pdfBuffer);
  const { text } = await extractText(uint8Array);
  return Array.isArray(text) ? text.join('\n') : text;
}
