import fs from "node:fs";

async function run() {
  console.log("Starting test...");
  
  try {
    const loginBuffer = fs.readFileSync("/Users/deepaknagendran/Opus/ClaimStatusCheck/1/IEHP - Website Details.xlsx");
    const claimBuffer = fs.readFileSync("/Users/deepaknagendran/Opus/ClaimStatusCheck/1/IEHP - Claim Details.xlsx");
    
    const loginFile = new File([loginBuffer], "IEHP - Website Details.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const claimFile = new File([claimBuffer], "IEHP - Claim Details.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    
    const formData = new FormData();
    formData.append("loginExcel", loginFile);
    formData.append("claimExcel", claimFile);
    
    console.log("Sending POST request to http://localhost:3000/api/process-claims ...");
    const response = await fetch("http://localhost:3000/api/process-claims", {
      method: "POST",
      body: formData
    });
    
    const json = await response.json();
    console.log("Response:", JSON.stringify(json, null, 2));
    
    if (json.outputFileBase64) {
      console.log("Writing output file...");
      fs.writeFileSync("output.xlsx", Buffer.from(json.outputFileBase64, "base64"));
      console.log("Wrote output.xlsx successfully.");
    }
    
  } catch (err) {
    console.error("Error:", err);
  }
}

run();
