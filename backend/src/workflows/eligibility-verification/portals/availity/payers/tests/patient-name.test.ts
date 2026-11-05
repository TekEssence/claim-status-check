import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { fillAvailityPatientName, resolveAvailityPatientName } from "../patient-name";

let browser: Browser;
before(async () => { browser = await chromium.launch({ channel: "chrome", headless: true }); });
after(async () => { await browser?.close(); });

test("resolves populated patient columns ahead of subscriber columns and blank aliases", () => {
  assert.deepEqual(resolveAvailityPatientName({
    "First Name": "", "Subscriber First Name": "Subscriber", " Patient First Name ": "Jane",
    "Last Name": "", "PATIENT_LAST_NAME": "Doe",
  }), { firstName: "Jane", lastName: "Doe" });
});

test("fills visible required names and replaces the previous patient's names", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<input name="patientFirstName" hidden value="hidden">
      <label>Patient First Name<input name="patientFirstName" required value="Previous"></label>
      <label>Patient Last Name<input name="patientLastName" required value="Patient"></label>`);
    await fillAvailityPatientName(page, { "Patient First Name": "Jane", "Patient Last Name": "Doe" });
    assert.equal(await page.getByLabel("Patient First Name", { exact: true }).inputValue(), "Jane");
    assert.equal(await page.getByLabel("Patient Last Name", { exact: true }).inputValue(), "Doe");
    await assert.rejects(fillAvailityPatientName(page, { "Patient First Name": "Jane" }), /Missing Patient Last Name/);
  } finally { await page.close(); }
});

test("selects the patient name search option when the workbook supplies names", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<label>Patient Search Option<select onchange="document.getElementById('names').hidden=false">
      <option>Patient ID, Date of Birth</option>
      <option>Patient ID, Patient Last Name, Patient First Name, Date of Birth</option>
      </select></label><div id="names" hidden>
      <input name="patientFirstName" required><input name="patientLastName" required></div>`);
    await fillAvailityPatientName(page, { "Patient First Name": "Jane", "Patient Last Name": "Doe" });
    assert.equal(await page.locator("input[name='patientFirstName']").inputValue(), "Jane");
    assert.equal(await page.locator("input[name='patientLastName']").inputValue(), "Doe");
  } finally { await page.close(); }
});

test("supports custom portal search dropdowns inside an iframe", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<iframe></iframe>');
    const frame = page.frames()[1];
    await frame.setContent(`<label id="search-label">Patient Search Option</label>
      <button role="combobox" aria-labelledby="search-label" onclick="document.getElementById('options').hidden=false">Patient ID, Date of Birth</button>
      <div id="options" hidden><div role="option" onclick="document.getElementById('names').hidden=false;document.getElementById('options').hidden=true">Patient ID, Patient Last Name, Patient First Name, Date of Birth</div></div>
      <div id="names" hidden><label>Patient First Name<input id="patientFirstName" aria-required="true"></label>
      <label>Patient Last Name<input id="patientLastName" aria-required="true"></label></div>`);
    await fillAvailityPatientName(frame, { "Patient First Name": "Jane", "Patient Last Name": "Doe" }, true);
    assert.equal(await frame.locator("#patientFirstName").inputValue(), "Jane");
    assert.equal(await frame.locator("#patientLastName").inputValue(), "Doe");
  } finally { await page.close(); }
});

test("allows ID and DOB only forms and clears optional stale names", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<input name="memberId">');
    await fillAvailityPatientName(page, {});
    await page.setContent('<input name="patientFirstName" value="Previous"><input name="patientLastName" value="Patient">');
    await fillAvailityPatientName(page, {});
    assert.equal(await page.locator("input[name='patientFirstName']").inputValue(), "");
    assert.equal(await page.locator("input[name='patientLastName']").inputValue(), "");
  } finally { await page.close(); }
});
