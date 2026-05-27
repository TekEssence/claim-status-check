import fs from 'fs';
import { extractTextFromPdf } from '../lib/claim-pdf';

const buf = fs.readFileSync('7_40000018584200_02-09-2026 (3).pdf');
const txt = extractTextFromPdf(buf);
const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);

let matchingLine = "";
const memberPolicyId = '40000018584200';
const dosStr = '02/09/2026';

for (let j = 0; j < lines.length; j++) {
  if (lines[j].includes(memberPolicyId)) {
    // Collect until we see another 14-digit member ID or hit 50 lines
    let end = j + 1;
    while (end < lines.length && end - j < 50) {
      if (/^\d{14}$/.test(lines[end])) break; // another member id
      end++;
    }
    const block = lines.slice(j, end);
    if (block.some(l => l.includes(dosStr))) {
       matchingLine = block.join(" ");
       break;
    }
  }
}
console.log('Result:', matchingLine);
