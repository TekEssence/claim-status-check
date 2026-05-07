const XLSX = require('xlsx');
const fs = require('fs');

// Create a mock workbook with a date
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet([
  ["DOS", "Status"],
  [new Date("2026-02-05"), "Pending"]
]);
XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

// Now read it back WITHOUT cellDates
const readWb1 = XLSX.read(buffer, { type: "buffer" });
const readWs1 = readWb1.Sheets["Sheet1"];
console.log("Without cellDates:", XLSX.utils.sheet_to_json(readWs1));

// Now read it back WITH cellDates
const readWb2 = XLSX.read(buffer, { type: "buffer", cellDates: true });
const readWs2 = readWb2.Sheets["Sheet1"];
console.log("With cellDates:", XLSX.utils.sheet_to_json(readWs2));

// Now read it back WITH raw: false
const readWb3 = XLSX.read(buffer, { type: "buffer" });
const readWs3 = readWb3.Sheets["Sheet1"];
console.log("With raw: false:", XLSX.utils.sheet_to_json(readWs3, { raw: false }));

