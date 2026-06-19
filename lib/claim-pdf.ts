import { getDocumentProxy } from 'unpdf';
import { PDFDocument, degrees } from "pdf-lib";
import type { PdfTextPage } from "./claim-ra";

/**
 * Extracts layout-aware text content from a PDF Buffer using unpdf.
 * Guarantees correct visual top-to-bottom, left-to-right ordering and precise spacing.
 */
export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  const uint8Array = new Uint8Array(pdfBuffer);
  const pdf = await getDocumentProxy(uint8Array);
  
  let fullText = "";
  
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    
    // Filter empty items and sort by Y descending (bottom-to-top PDF coordinates), then X ascending
    const items = content.items.filter((i: any) => i.str && i.str.trim() !== "");
    items.sort((a: any, b: any) => {
      const ay = a.transform[5];
      const by = b.transform[5];
      // Group items on the same visual line (within a 2-point delta)
      if (Math.abs(ay - by) > 2) {
        return by - ay;
      }
      return a.transform[4] - b.transform[4];
    });

    let currentY = -999;
    let lineStr = "";
    let lastRight = 0;
    
    for (const item of items as any[]) {
      const x = item.transform[4];
      const y = item.transform[5];
      const width = item.width || (item.str.length * 5); // Fallback width estimation if missing
      
      if (Math.abs(y - currentY) > 2) {
        if (lineStr) fullText += lineStr.trim() + "\n";
        lineStr = item.str;
        currentY = y;
        lastRight = x + width;
      } else {
        // If gap between end of last item and start of this one is > 2, add a space
        if (x - lastRight > 2) {
          lineStr += " " + item.str;
        } else {
          lineStr += item.str;
        }
        lastRight = x + width;
      }
    }
    if (lineStr) fullText += lineStr.trim() + "\n";
  }

  return fullText;
}

export async function extractTextPagesFromPdf(pdfBuffer: Buffer): Promise<PdfTextPage[]> {
  const uint8Array = new Uint8Array(pdfBuffer);
  const pdf = await getDocumentProxy(uint8Array);
  const pages: PdfTextPage[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    pages.push({
      pageNumber: p,
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
      items: content.items
        .filter((item: any) => item.str && item.str.trim() !== "")
        .map((item: any) => ({
          str: item.str,
          x: item.transform[4],
          y: viewport.height - item.transform[5],
          width: item.width || item.str.length * 5,
          height: item.height,
        })),
    });
  }

  return pages;
}

export async function rotatePdfBuffer(
  pdfBuffer: Buffer,
  rotationDegrees: 0 | 90 | 180 | 270,
  startPageNumber = 1,
): Promise<Buffer> {
  if (rotationDegrees === 0) {
    return pdfBuffer;
  }

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  for (let index = Math.max(0, startPageNumber - 1); index < pages.length; index++) {
    pages[index].setRotation(degrees(rotationDegrees));
  }

  const rotatedBytes = await pdfDoc.save();
  return Buffer.from(rotatedBytes);
}
