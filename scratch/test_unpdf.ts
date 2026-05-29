import fs from 'fs';
import { getDocumentProxy } from 'unpdf';

async function run() {
  const buf = fs.readFileSync('7_40000018584200_02-09-2026 (3).pdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  
  let fullText = "";
  
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    
    // Sort items by Y descending (PDF coordinates: bottom-left is 0,0)
    // and then X ascending
    const items = content.items.filter((i: any) => i.str.trim() !== "");
    items.sort((a: any, b: any) => {
      const ay = a.transform[5];
      const by = b.transform[5];
      if (Math.abs(ay - by) > 2) {
        return by - ay;
      }
      return a.transform[4] - b.transform[4];
    });

    // Group into lines
    let currentY = -999;
    let lineStr = "";
    let lastRight = 0;
    
    for (const item of items as any[]) {
      const x = item.transform[4];
      const y = item.transform[5];
      const width = item.width;
      
      if (Math.abs(y - currentY) > 2) {
        if (lineStr) fullText += lineStr + "\n";
        lineStr = item.str;
        currentY = y;
        lastRight = x + width;
      } else {
        // If there is a noticeable gap between the previous word and this word, add a space
        if (x - lastRight > 2) {
          lineStr += " " + item.str;
        } else {
          lineStr += item.str;
        }
        lastRight = x + width;
      }
    }
    if (lineStr) fullText += lineStr + "\n";
  }
  
  console.log("Extraction Result:");
  console.log(fullText.substring(0, 1500));
}
run();
