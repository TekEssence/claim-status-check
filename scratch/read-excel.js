const XLSX = require('xlsx');
try {
  const wb = XLSX.readFile('output.xlsx');
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);
  
  console.log('Total rows in output.xlsx:', rows.length);
  
  // Find columns that might contain "Refer" or "RA"
  let matchCount = 0;
  rows.forEach((row, i) => {
    const details = String(row.BotClaimDetails || row.botclaimdetails || '');
    const status = String(row.BotClaimStatusCheck || row.botclaimstatuscheck || '');
    const error = String(row.BotClaimStatusCheckError || row.botclaimstatuscheckerror || '');
    
    const hasRefer = details.toLowerCase().includes('refer') || 
                      status.toLowerCase().includes('refer') || 
                      error.toLowerCase().includes('refer') ||
                      details.toLowerCase().includes('ra') ||
                      status.toLowerCase().includes('ra');
                      
    if (hasRefer) {
      matchCount++;
      console.log(`\n--- Row ${i + 2} in Excel ---`);
      console.log('Member Policy ID:', row['Member Policy ID'] || row['Member ID']);
      console.log('Date Of Service:', row['Date Of Service'] || row['DOS']);
      console.log('BotClaimStatusCheck:', status);
      console.log('BotClaimDetails:', details.substring(0, 300));
    }
  });
  console.log(`\nTotal matched rows: ${matchCount}`);
} catch (e) {
  console.error('Error reading Excel file:', e.message);
}
