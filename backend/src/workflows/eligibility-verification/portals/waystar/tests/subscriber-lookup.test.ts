import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { ensureWaystarSubscriberLookup } from "../portal";

const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));

test("Minimax lookup reveals subscriber ID, preserves a correct selection, and recovers a reset", {
  skip: !executablePath,
}, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<select id="PatientLookup">
      <option value="3">Sbr ID, DOB</option><option value="29">CUMB ID, DOB</option>
      <option value="25" selected>LName, FName, DOB</option>
      <option value="10">Sbr ID, LName, FName, DOB</option></select>
      <input id="SbrId" style="display:none"><input id="LName"><input id="FName"><input id="DOB">
      <script>
        let resetOnce = false;
        PatientLookup.addEventListener('change', () => {
          if (resetOnce) { PatientLookup.value = '25'; resetOnce = false; }
          SbrId.style.display = PatientLookup.value === '10' ? '' : 'none';
        });
      </script>`);
    await ensureWaystarSubscriberLookup(page);
    assert.equal(await page.locator("#PatientLookup").inputValue(), "10");
    assert.equal(await page.locator("#SbrId").isVisible(), true);
    await page.locator("#SbrId").fill("TEST-MEMBER");
    await page.evaluate("PatientLookup.addEventListener('change', () => { SbrId.value = ''; })");
    await ensureWaystarSubscriberLookup(page);
    assert.equal(await page.locator("#SbrId").inputValue(), "TEST-MEMBER", "a correct lookup should not trigger another form reset");
    await page.evaluate("PatientLookup.value = '25'; SbrId.style.display = 'none'; resetOnce = true;");
    await ensureWaystarSubscriberLookup(page);
    assert.equal(await page.locator("#PatientLookup").inputValue(), "10");
    assert.equal(await page.locator("#SbrId").isVisible(), true);
  } finally {
    await browser.close();
  }
});
