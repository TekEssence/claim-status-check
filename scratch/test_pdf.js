const fs = require('fs');
const pdf = require('pdf-parse');

async function extractTextFromPdfBuffer(buffer) {
  const data = await pdf(buffer);
  return data.text;
}

async function run() {
  const buf = fs.readFileSync('7_40000018584200_02-09-2026 (3).pdf');
  const txt = await extractTextFromPdfBuffer(buf);
  const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
  const idx = lines.findIndex(l => l.includes('40000018584200'));
  console.log('Lines around match:');
  console.log(lines.slice(Math.max(0, idx - 2), idx + 10).join('\n'));
}
run();
