import fs from 'fs';
import { extractTextFromPdf } from '../lib/claim-pdf';

async function run() {
  const buf = fs.readFileSync('downloads/13768222683_RA.pdf');
  const txt = await extractTextFromPdf(buf);
  const pdfLines = txt.split("\n").map((l: string) => l.trim()).filter(Boolean);
  
  // same testing logic as route.ts
  const memberPolicyId = "0127575859"; // from the user's screenshot
  const dosStr = "02/09/2026"; 

  let matchingLine = "";
  for (let j = 0; j < pdfLines.length; j++) {
    if (pdfLines[j].includes(memberPolicyId)) {
      let end = j + 1;
      while (end < pdfLines.length && end - j < 50) {
        if (/^\d{14}$/.test(pdfLines[end])) break; 
        end++;
      }
      const block = pdfLines.slice(j, end);
      if (block.some((l: string) => l.includes(dosStr))) {
        matchingLine = block.join(" ");
        break;
      }
    }
  }

  console.log(matchingLine);
}
run();
