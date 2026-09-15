import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { loginOfficeAlly, loadOfficeAllyReports, downloadOfficeAllyReport } from "./scraper";

test("Office Ally browser flow searches each date and saves original VIEW downloads", {
  skip: process.env.OFFICE_ALLY_BROWSER_TEST !== "1",
}, async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "office-ally-browser-"));
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const zip = Buffer.alloc(22); zip.writeUInt32LE(0x06054b50);
    const filename = "1640601333_ERA_STATUS_5010_20260910.zip";
    const searches: string[] = [];
    await page.route("https://www.officeally.com/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/download") {
        await route.fulfill({ contentType: "application/zip", headers: { "Content-Disposition": `attachment; filename="${filename}"` }, body: zip });
        return;
      }
      let html = "";
      if (url.pathname === "/sLogin.aspx") {
        html = '<input id="username"><input id="password"><button onclick="location.href=\'/home\'">Continue</button>';
      } else if (url.pathname === "/home") {
        html = '<div id="pendo-guide-container"><button aria-label="Close" onclick="this.parentNode.remove()">X</button></div><a href="/reports">Download EOB / ERA 835</a>';
      } else {
        const date = url.searchParams.get("date") ?? "9/1/2026";
        if (url.searchParams.has("date")) searches.push(date);
        html = `<select id="lstReportBy"><option value="date">Daily</option><option value="month">Monthly</option></select>
          <select id="lstReportType"><option value="0">All</option></select>
          <input id="txtMonth"><input id="txtDay"><input id="txtYear">
          <input type="button" id="Button1" value="Go" onclick="location.href='/reports?date='+txtMonth.value+'/'+txtDay.value+'/'+txtYear.value">
          <div id="divReport"><b>Daily EOB / ERA 835 Reports for ${date} - [Report Type = All]</b>
          <table>${date === "9/10/2026" ? `<tr id="dnl_1"><td>${date}</td><td>ERA 835</td><td>1640601333</td><td>${filename}</td><td>36E790D5</td><td>1</td><td><a target="_new" href="/download">VIEW</a></td></tr>` : ""}</table></div>`;
      }
      await route.fulfill({ contentType: "text/html", body: html });
    });
    await loginOfficeAlly(page, { loginUrl: "https://www.officeally.com/sLogin.aspx", username: "dummy", password: "dummy", dates: [] });
    const rows = await loadOfficeAllyReports(page, "9/10/2026");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eobId, "36E790D5");
    await downloadOfficeAllyReport(page, 0, rows[0], folder);
    assert.equal(rows[0].status, "Downloaded");
    assert.deepEqual(await fs.readFile(path.join(folder, filename)), zip);
    assert.deepEqual(await loadOfficeAllyReports(page, "9/11/2026"), []);
    assert.deepEqual(searches, ["9/10/2026", "9/11/2026"]);
  } finally {
    await browser.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
