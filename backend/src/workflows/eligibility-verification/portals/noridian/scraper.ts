import ExcelJS from "exceljs";
import type { Page } from "playwright-core";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { closeAutomationResources, getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";
import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import type { AutomationRunner } from "../../../types";
import type { EligibilityRunInput } from "../../types";
import { parseEligibilityProjectId } from "../../projects";
import { readNoridianCredentials, type NoridianCredentials } from "./credentials";

const OUTPUT_HEADERS = [
  "Part B Beneficiary Details", "Effective Date", "Termination Date", "Entitlement Reason", "Eligibility",
  "HMO/MA", "HMO/MA Insurer Name", "HMO/MA Plan Code Number", "HMO/MA PBP Plan Number",
  "HMO/MA PBP Plan Name", "HMO/MA Effective Date", "HMO/MA Termination Date", "HMO/MA Plan Type",
  "HMO/MA Bill Option Code", "HMO/MA Address", "HMO/MA Phone Number", "HMO/MA Contract Web Site",
  "MSP", "Hospice", "Error",
] as const;
type Result = Record<(typeof OUTPUT_HEADERS)[number], string>;

const normalize = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const cellText = (value: ExcelJS.CellValue) => value && typeof value === "object" && "text" in value ? String(value.text ?? "").trim() : String(value ?? "").trim();
const emptyResult = (): Result => Object.fromEntries(OUTPUT_HEADERS.map((header) => [header, ""])) as Result;
const outputValue = (value: string) => value.trim() || "-";

function styleNoridianOutputColumns(sheet: ExcelJS.Worksheet, outputColumns: Map<string, number>) {
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFB4C6E7" } },
      left: { style: "thin", color: { argb: "FFB4C6E7" } },
      bottom: { style: "thin", color: { argb: "FFB4C6E7" } },
      right: { style: "thin", color: { argb: "FFB4C6E7" } },
    };
  });
  for (const [header, column] of outputColumns) {
    sheet.getColumn(column).width = Math.max(14, Math.min(32, header.length + 2));
  }
  headerRow.height = Math.max(headerRow.height || 15, 30);
}

function styleNoridianOutputCell(cell: ExcelJS.Cell) {
  cell.alignment = { vertical: "top", wrapText: true };
  cell.border = {
    top: { style: "thin", color: { argb: "FFD9E2F3" } },
    left: { style: "thin", color: { argb: "FFD9E2F3" } },
    bottom: { style: "thin", color: { argb: "FFD9E2F3" } },
    right: { style: "thin", color: { argb: "FFD9E2F3" } },
  };
}

function copyWorksheetValues(source: ExcelJS.Worksheet, target: ExcelJS.Worksheet) {
  source.eachRow({ includeEmpty: true }, (sourceRow, rowNumber) => {
    const targetRow = target.getRow(rowNumber);
    sourceRow.eachCell({ includeEmpty: true }, (sourceCell, columnNumber) => {
      targetRow.getCell(columnNumber).value = sourceCell.value;
    });
    targetRow.height = sourceRow.height;
  });
  for (let column = 1; column <= source.columnCount; column += 1) {
    target.getColumn(column).width = source.getColumn(column).width;
  }
}

function styleLogSheet(sheet: ExcelJS.Worksheet) {
  const header = sheet.getRow(1);
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B9BD5" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  header.height = 26;
  sheet.columns.forEach((column) => { column.width = 24; });
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.eachCell((cell) => { cell.alignment = { vertical: "top", wrapText: true }; });
  });
}

export function parseNoridianPatientName(patientName: string): { lastName: string; firstName: string } {
  const comma = patientName.indexOf(",");
  if (comma < 1) throw new Error('Patient Name must use the format "LAST NAME, FIRST NAME".');
  const lastName = patientName.slice(0, comma).trim();
  const givenNames = patientName.slice(comma + 1).trim().split(/\s+/).filter(Boolean);
  const firstName = givenNames[0] ?? "";
  if (!lastName || !firstName) throw new Error('Patient Name must contain both last and first name in "LAST NAME, FIRST NAME" format.');
  return { lastName, firstName };
}

function requireFile(formData: FormData, key: string, label: string): File {
  const file = formData.get(key);
  if (!(file instanceof File) || !file.size) throw new Error(`${label} is required.`);
  return file;
}

async function acceptDisclaimer(page: Page) {
  const accept = page.getByRole("button", { name: /^Accept$/i }).first();
  if (await accept.isVisible({ timeout: 3000 }).catch(() => false)) await accept.click();
}

async function enterNoridianLoginValue(page: Page, selector: "#username" | "#password", value: string, label: string) {
  const field = page.locator(selector);
  await field.waitFor({ state: "visible", timeout: 30_000 });
  await field.scrollIntoViewIfNeeded();
  // Noridian intentionally renders login inputs readonly and removes the
  // attribute from its onfocus handler. Remove it after an explicit focus so
  // Playwright does not wait forever for the field to become editable.
  await field.focus();
  await field.evaluate((element: HTMLInputElement) => {
    element.readOnly = false;
    element.removeAttribute("readonly");
  });
  await field.click({ force: true });
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  // Noridian flags programmatic fill() as browser autofill. Dispatch genuine
  // key events so the portal observes normal user-style credential entry.
  await field.pressSequentially(value, { delay: selector === "#password" ? 110 : 70 });
  if (await field.inputValue() !== value) throw new Error(`Noridian ${label} field did not retain the entered value.`);
}

async function continueNoridianAutofillWarning(page: Page, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const continueButton = frame.locator("button#btn-continue").first();
      if (!await continueButton.isVisible({ timeout: 250 }).catch(() => false)) continue;
      await continueButton.scrollIntoViewIfNeeded().catch(() => {});
      await continueButton.waitFor({ state: "visible", timeout: 5000 });
      let clicked = await continueButton.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
      if (!clicked || await continueButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        clicked = await continueButton.evaluate((button: HTMLElement) => {
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
          return true;
        }).catch(() => false);
      }
      if (!clicked) throw new Error("Noridian password-autofill Continue button was visible but could not be clicked.");
      const closed = await continueButton.waitFor({ state: "hidden", timeout: 10_000 }).then(() => true).catch(() => false);
      if (!closed) throw new Error("Noridian Continue was clicked, but the password-autofill dialog remained open.");
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function selectNoridianEmailOtpDelivery(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const heading = frame.getByText(/choose the delivery method for your one-time passcode/i).first();
      if (!await heading.isVisible({ timeout: 250 }).catch(() => false)) continue;

      // Noridian renders the delivery name as a span; it is not itself the
      // checkbox. Use that stable span to stay inside the Email option row.
      const emailText = frame.locator("span.dispName").filter({ hasText: /^\s*Email\s*$/i }).first();
      await emailText.waitFor({ state: "visible", timeout: 5000 });
      const associatedEmailControl = emailText.locator(
        'xpath=ancestor::*[.//input[@type="radio" or @type="checkbox"]][1]//input[@type="radio" or @type="checkbox"]',
      ).first();
      const emailControl = await associatedEmailControl.count() ? associatedEmailControl : frame.locator([
        'input[type="radio"][value*="email" i]',
        'input[type="checkbox"][value*="email" i]',
        'input[type="radio"][id*="email" i]',
        'input[type="checkbox"][id*="email" i]',
        'input[type="radio"][name*="email" i]',
        'input[type="checkbox"][name*="email" i]',
        'input[type="radio"]',
        'input[type="checkbox"]',
        '[role="radio"]',
        '[role="checkbox"]',
      ].join(", ")).first();

      let selected = false;
      if (await emailControl.count()) {
        selected = await emailControl.evaluate((control: HTMLElement) => {
          if (control instanceof HTMLInputElement) {
            if (!control.checked) control.click();
            if (!control.checked) {
              control.checked = true;
              control.dispatchEvent(new Event("input", { bubbles: true }));
              control.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return control.checked;
          }
          control.click();
          return control.getAttribute("aria-checked") === "true";
        }).catch(() => false);
      }
      if (!selected) {
        // The visible square is commonly a sibling of span.dispName. Clicking
        // the enclosing Email option lets the portal's own widget handler run.
        await emailText.evaluate((span) => {
          let option: HTMLElement | null = span.parentElement;
          for (let depth = 0; option && depth < 5; depth += 1, option = option.parentElement) {
            const input = option.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]');
            if (input) {
              input.click();
              return;
            }
          }
          (span.parentElement ?? span as HTMLElement).click();
        }).catch(() => {});
        selected = await emailControl.isChecked().catch(() => false);
      }
      if (!selected) {
        const box = await emailText.boundingBox();
        if (box) {
          await page.mouse.click(Math.max(1, box.x - 42), box.y + box.height / 2);
          selected = await emailControl.isChecked().catch(() => true);
        }
      }
      if (!selected) throw new Error("Noridian Email delivery option was visible but could not be selected.");

      const submit = frame.getByRole("button", { name: /^Submit$/i }).first()
        .or(frame.locator('input[type="submit"][value="Submit"], input[type="button"][value="Submit"]').first());
      await submit.waitFor({ state: "visible", timeout: 10_000 });
      await submit.click({ force: true });
      return;
    }
    await page.waitForTimeout(250);
  }
  // Some accounts proceed directly to the OTP input without asking for a
  // delivery method; do not fail that supported path.
  if (await page.locator("#EMailPassword").isVisible({ timeout: 1000 }).catch(() => false)) return;
  throw new Error("Noridian did not display either the email delivery selection or the OTP input after login.");
}

async function login(page: Page, credentials: NoridianCredentials, context: Parameters<AutomationRunner<EligibilityRunInput>["run"]>[1]) {
  const directLoginUrl = "https://esp.noridianmedicareportal.com/nidp/app/login?id=AC_NMP&option=credential&sid=0";
  const loginUrls = Array.from(new Set([
    credentials.loginUrl,
    directLoginUrl,
    "https://www.noridianmedicareportal.com/",
  ]));
  let lastError: unknown = null;
  for (const [index, loginUrl] of loginUrls.entries()) {
    try {
      await context.log({ level: "info", message: `Opening Noridian login page (attempt ${index + 1}/${loginUrls.length}).`, eventName: "eligibility_noridian_login_navigation", meta: { loginUrl } });
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await context.log({ level: "warn", message: `Noridian login navigation attempt ${index + 1} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, eventName: "eligibility_noridian_login_navigation_failed", meta: { loginUrl } });
    }
  }
  if (lastError) throw lastError;
  await acceptDisclaimer(page);
  await enterNoridianLoginValue(page, "#username", credentials.username, "username");
  await enterNoridianLoginValue(page, "#password", credentials.password, "password");
  const continued = await continueNoridianAutofillWarning(page, 5000);
  if (!continued) {
    const loginButton = page.locator('input[type="submit"][value="Login"]').first();
    const loginClicked = await loginButton.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!loginClicked) {
      throw new Error("Noridian Login button could not be clicked.");
    }
    await continueNoridianAutofillWarning(page, 8000);
  }
  await selectNoridianEmailOtpDelivery(page);
  const otpField = page.locator("#EMailPassword");
  await otpField.waitFor({ state: "visible", timeout: 60_000 });
  const inputName = `noridian_otp_${crypto.randomUUID()}`;
  const timeoutMs = 10 * 60 * 1000;
  await context.emit({ type: "otp_request", inputName, label: "Noridian email verification code", message: "Enter the one-time password sent by Noridian email.", timeoutMs });
  const otp = await waitForScrapeJobInput(context.jobId, inputName, timeoutMs);
  await otpField.fill(otp.trim());
  await page.locator('input[name="loginButton2"]').click();

  // A successful OTP first lands on an OpenText Access Manager page saying
  // "Your session has been authenticated." Noridian then performs a delayed
  // server-side redirect to the actual portal, which can take about a minute.
  const authenticatedMessage = page.getByText(/your session has been authenticated/i).first();
  const authenticated = await authenticatedMessage.isVisible({ timeout: 15_000 }).catch(() => false);
  if (authenticated) {
    await context.log({
      level: "info",
      message: "Noridian authenticated the session. Waiting for the portal home page redirect.",
      eventName: "eligibility_noridian_authenticated_waiting_for_portal",
    });
  }

  const portalMenu = page.getByText("Eligibility or MBI Lookup", { exact: false }).first();
  let portalReady = await portalMenu.waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  const strandedOnAccessManager = /esp\.noridianmedicareportal\.com\/nidp\/app/i.test(page.url());
  if (!portalReady && (authenticated || strandedOnAccessManager)) {
    // Access Manager sometimes authenticates successfully but loses the relay
    // destination and remains on /nidp/app?sid=0. Reuse that authenticated
    // session and explicitly open the official Noridian portal home page.
    // Chrome hides the leading "www" in its address bar, but the bare host
    // does not resolve in every DNS/VPN environment.
    const portalHomeUrl = "https://www.noridianmedicareportal.com/group/end-user";
    await context.log({
      level: "info",
      message: "Noridian did not complete its automatic redirect. Opening the authenticated portal home page.",
      eventName: "eligibility_noridian_opening_authenticated_portal_home",
      meta: { portalHomeUrl },
    });
    await page.goto(portalHomeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    portalReady = await portalMenu.waitFor({ state: "visible", timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
  }

  if (!portalReady) {
    throw new Error(
      `Noridian authenticated the session but the portal home page did not become available. Current URL: ${page.url()}.`,
    );
  }
}

async function chooseConfiguredValue(page: Page, label: RegExp) {
  // Noridian's provider fields are jQuery-style comboboxes rather than native
  // selects. Their stable markup is three ordered "Please Type or Select"
  // inputs with adjacent span.combo-icon buttons: TIN/SSN, NPI, then PTAN.
  const source = label.source.toLowerCase();
  const comboIndex = source.includes("tin") || source.includes("ssn")
    ? 0
    : source.includes("npi")
      ? 1
      : 2;
  const comboInputs = page.locator('input[placeholder*="Please Type or Select" i]');
  if (await comboInputs.count() >= 3) {
    const input = comboInputs.nth(comboIndex);
    const icons = page.locator("span.combo-icon");
    const icon = icons.nth(comboIndex);
    await input.scrollIntoViewIfNeeded();
    await icon.click({ force: true });

    const visibleOption = page.locator([
      ".ui-autocomplete:visible .ui-menu-item",
      ".ui-menu:visible .ui-menu-item",
      "[role='listbox']:visible [role='option']",
      ".yui3-aclist:visible .yui3-aclist-item",
    ].join(", ")).filter({ hasNotText: /^\s*(?:select|choose)\s*$/i }).first();
    if (await visibleOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await visibleOption.click({ force: true });
    } else {
      // Keyboard selection also triggers the combobox's own change handler.
      await input.focus();
      await input.press("ArrowDown");
      await input.press("Enter");
    }

    const selectedValue = await input.inputValue().catch(() => "");
    if (!selectedValue.trim() || /please type or select/i.test(selectedValue)) {
      throw new Error(`Noridian ${label.source} dropdown opened but no configured value was selected.`);
    }
    return;
  }

  const labeledControl = page.getByLabel(label).first();
  if (await labeledControl.count() && await labeledControl.evaluate((element) => element.tagName === "SELECT").catch(() => false)) {
    const optionValue = await labeledControl.locator("option").evaluateAll((options) =>
      options.map((option) => ({
        value: (option as HTMLOptionElement).value,
        text: option.textContent?.trim() ?? "",
      })).find((option) => option.value && !/select|choose/i.test(option.text))?.value ?? "",
    );
    if (!optionValue) throw new Error(`No configured ${label.source} value is available in Noridian.`);
    await labeledControl.selectOption(optionValue);
    return;
  }
  const labelNode = page.getByText(label, { exact: false }).first();
  const container = labelNode.locator("xpath=ancestor::*[self::div or self::td][1]");
  const button = container.locator("button, [role='combobox'], .combo-icon").first();
  await button.click();
  const option = page.locator("[role='option']:visible, .ui-menu-item:visible, .yui3-aclist-item:visible").filter({ hasNotText: /select|choose/i }).first();
  if (!await option.isVisible({ timeout: 5000 }).catch(() => false)) {
    throw new Error(`No configured ${label.source} value is available in Noridian.`);
  }
  await option.click();
}

async function openLookup(page: Page) {
  await page.getByText("Eligibility or MBI Lookup", { exact: false }).first().click();
  await page.locator("#hicn").waitFor({ state: "visible", timeout: 60_000 });
  await chooseConfiguredValue(page, /TIN\s*\/\s*SSN|TIN|SSN/i);
  await chooseConfiguredValue(page, /NPI/i);
  await chooseConfiguredValue(page, /PTAN/i);
}

async function panelText(page: Page, href: string): Promise<string> {
  const tab = page.locator(`a[href="${href}"]`).first();
  if (await tab.isVisible({ timeout: 1000 }).catch(() => false)) await tab.click().catch(() => {});
  return page.locator(href).first().innerText({ timeout: 3000 }).catch(() => "");
}

async function panelLabeledValues(page: Page, href: string): Promise<Record<string, string>> {
  const tab = page.locator(`a[href="${href}"]`).first();
  if (await tab.isVisible({ timeout: 1000 }).catch(() => false)) await tab.click().catch(() => {});
  const panel = page.locator(href).first();
  return panel.locator("strong").evaluateAll((labels) => {
    const values: Record<string, string> = {};
    for (const [index, label] of labels.entries()) {
      const key = (label.textContent ?? "").replace(/\s+/g, " ").replace(/:\s*$/, "").trim();
      if (!key) continue;
      const range = document.createRange();
      range.setStartAfter(label);
      const nextLabel = labels[index + 1];
      if (nextLabel) range.setEndBefore(nextLabel);
      else {
        const container = label.closest(".my-2") ?? label.parentElement;
        if (!container) continue;
        const clone = container.cloneNode(true) as HTMLElement;
        clone.querySelector("strong")?.remove();
        values[key] = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
        continue;
      }
      values[key] = (range.cloneContents().textContent ?? "").replace(/\s+/g, " ").trim();
    }
    return values;
  }).catch(() => ({}));
}

async function panelBenefitResult(page: Page, href: string): Promise<string> {
  const tab = page.locator(`a[href="${href}"]`).first();
  if (await tab.isVisible({ timeout: 1000 }).catch(() => false)) await tab.click().catch(() => {});
  const panel = page.locator(href).first();
  const noBenefits = panel.locator("strong").filter({
    hasText: /no benefits available for the requested date span/i,
  }).first();
  if (await noBenefits.isVisible({ timeout: 1500 }).catch(() => false)) {
    return (await noBenefits.innerText()).replace(/\s+/g, " ").trim();
  }
  return (await panel.innerText({ timeout: 3000 }).catch(() => "")).replace(/\s+/g, " ").trim();
}

function labeledValue(values: Record<string, string>, label: string, emptyValue = ""): string {
  const match = Object.entries(values).find(([key]) => normalize(key) === normalize(label));
  return match?.[1]?.trim() || emptyValue;
}

export async function extractNoridianResult(page: Page): Promise<Result> {
  const eligibility = await panelText(page, "#eligibility");
  const eligibilityValues = await panelLabeledValues(page, "#eligibility");
  const hmoText = await panelText(page, "#hmo");
  const hmoValues = await panelLabeledValues(page, "#hmo");
  return {
    "Part B Beneficiary Details": eligibility.match(/Part B\s*-?\s*Beneficiary Details[\s\S]*?(?=\n\s*(?:Part [A-Z]|Eligibility|HMO\/MA|MSP|Hospice)\b|$)/i)?.[0]?.trim() ?? eligibility,
    "Effective Date": labeledValue(eligibilityValues, "Effective Date", "N/A"),
    "Termination Date": labeledValue(eligibilityValues, "Termination Date", "N/A"),
    "Entitlement Reason": labeledValue(eligibilityValues, "Entitlement Reason", "N/A"),
    "Eligibility": eligibility,
    "HMO/MA": hmoText,
    "HMO/MA Insurer Name": labeledValue(hmoValues, "Insurer Name", "N/A"),
    "HMO/MA Plan Code Number": labeledValue(hmoValues, "Plan Code Number", "N/A"),
    "HMO/MA PBP Plan Number": labeledValue(hmoValues, "MA PBP Plan Number", "N/A"),
    "HMO/MA PBP Plan Name": labeledValue(hmoValues, "MA PBP Plan Name", "N/A"),
    "HMO/MA Effective Date": labeledValue(hmoValues, "Effective Date", "N/A"),
    "HMO/MA Termination Date": labeledValue(hmoValues, "Termination Date", "N/A"),
    "HMO/MA Plan Type": labeledValue(hmoValues, "MA Plan Type", "N/A"),
    "HMO/MA Bill Option Code": labeledValue(hmoValues, "MA Bill Option Code", "N/A"),
    "HMO/MA Address": labeledValue(hmoValues, "Address", "N/A"),
    "HMO/MA Phone Number": labeledValue(hmoValues, "Phone Number", "N/A"),
    "HMO/MA Contract Web Site": labeledValue(hmoValues, "Contract Web Site", "N/A"),
    "MSP": await panelBenefitResult(page, "#msp"),
    "Hospice": await panelBenefitResult(page, "#hospice"),
    "Error": "",
  };
}

function findColumn(sheet: ExcelJS.Worksheet, aliases: string[]): number {
  const wanted = new Set(aliases.map(normalize));
  let found = 0;
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => { if (wanted.has(normalize(cellText(cell.value)))) found = column; });
  return found;
}

export function createNoridianEligibilityRunner(): AutomationRunner<EligibilityRunInput> {
  return {
    workflowId: "eligibility-verification",
    portalId: "noridian",
    name: "Noridian Eligibility Verification",
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("Noridian eligibility input must be multipart form data.");
      const projectId = parseEligibilityProjectId(input.get("projectId"));
      if (projectId !== "medrevenue") throw new Error("Noridian eligibility is available only for the MedRevenue project.");
      return { projectId, inputFile: requireFile(input, "inputFile", "Eligibility input file"), credentialFile: requireFile(input, "credentialFile", "Noridian login file") };
    },
    async run(input, context) {
      // Noridian is itself restricted to MedRevenue, so the supplied workbook
      // does not need a Project column in addition to its required patient fields.
      const inputFile = input.inputFile;
      const credentials = await readNoridianCredentials(input.credentialFile);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await inputFile.arrayBuffer());
      const inputSheet = workbook.worksheets[0];
      if (!inputSheet) throw new Error("Noridian eligibility workbook does not contain a worksheet.");
      inputSheet.name = "Input";
      const sheet = workbook.addWorksheet("Output");
      copyWorksheetValues(inputSheet, sheet);
      const auditSheet = workbook.addWorksheet("Audit Log");
      auditSheet.addRow(["Timestamp", "Row", "Patient Name", "Primary Insurance ID#", "Status", "Message"]);
      const errorSheet = workbook.addWorksheet("Error Log");
      errorSheet.addRow(["Timestamp", "Row", "Patient Name", "Primary Insurance ID#", "Error"]);
      const patientNameColumn = findColumn(sheet, ["Patient Name"]);
      const medicareNumberColumn = findColumn(sheet, ["Primary Insurance ID#", "Primary Insurance ID"]);
      if (!patientNameColumn || !medicareNumberColumn) throw new Error('Noridian input requires "Patient Name" and "Primary Insurance ID#" columns.');
      const outputColumns = new Map<string, number>();
      for (const header of OUTPUT_HEADERS) { const column = sheet.columnCount + 1; sheet.getCell(1, column).value = header; outputColumns.set(header, column); }
      styleNoridianOutputColumns(sheet, outputColumns);
      const rowNumbers = Array.from({ length: Math.max(0, sheet.rowCount - 1) }, (_, index) => index + 2);
      await context.emit({ type: "progress", completed: 0, total: rowNumbers.length });
      await context.log({ level: "info", message: `Starting ${rowNumbers.length} MedRevenue Noridian eligibility row(s).`, eventName: "eligibility_noridian_started", meta: { projectId: "medrevenue" } });
      const runtime = getAutomationRuntimeConfig();
      const noridianHeadless = runtime.environment !== "local";
      await context.log({ level: "info", message: `Launching Noridian browser in ${noridianHeadless ? "headless" : "visible headed"} mode.`, eventName: "eligibility_noridian_browser_launch" });
      const { browser, context: browserContext } = await launchAutomationBrowser({ headless: noridianHeadless });
      const page = await browserContext.newPage();
      try {
        await login(page, credentials, context);
        await openLookup(page);
        let completed = 0;
        for (const rowNumber of rowNumbers) {
          const row = sheet.getRow(rowNumber);
          const patientName = cellText(row.getCell(patientNameColumn).value);
          const medicareNumber = cellText(row.getCell(medicareNumberColumn).value).replace(/\s+/g, "");
          let result = emptyResult();
          try {
            await context.log({ level: "info", message: `Row ${rowNumber}: submitting the Noridian eligibility lookup.`, eventName: "eligibility_noridian_row_started", rowIndex: rowNumber });
            if (!patientName) throw new Error("Patient Name is missing.");
            if (!/^[A-Za-z0-9]{2,12}$/.test(medicareNumber)) throw new Error("Primary Insurance ID# must contain 2 to 12 alphanumeric characters.");
            const name = parseNoridianPatientName(patientName);
            await page.locator("#hicn").fill(medicareNumber);
            await page.locator("#lastName").fill(name.lastName);
            await page.locator("#firstName").fill(name.firstName);
            await page.locator("#btnSubmit").click();
            await page.locator('a[href="#eligibility"]').first().waitFor({ state: "visible", timeout: 60_000 });
            result = await extractNoridianResult(page);
            await context.log({ level: "info", message: `Row ${rowNumber}: Noridian eligibility results extracted.`, eventName: "eligibility_noridian_row_complete", rowIndex: rowNumber });
          } catch (error) {
            result.Error = error instanceof Error ? error.message : "Noridian row processing failed.";
            await context.log({ level: "error", message: `Row ${rowNumber}: ${result.Error}`, eventName: "eligibility_noridian_row_failed", rowIndex: rowNumber });
            const screenshot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
            if (screenshot) await context.emit({ type: "error_screenshot", index: rowNumber, filename: `noridian-row-${rowNumber}.jpg`, image: screenshot.toString("base64"), mimeType: "image/jpeg" });
          }
          for (const header of OUTPUT_HEADERS) {
            const cell = row.getCell(outputColumns.get(header)!);
            cell.value = outputValue(result[header]);
            styleNoridianOutputCell(cell);
          }
          const processedAt = new Date().toISOString();
          const status = result.Error ? "Failed" : "Completed";
          const message = result.Error || "Noridian eligibility verification completed.";
          auditSheet.addRow([processedAt, rowNumber, patientName || "N/A", medicareNumber || "N/A", status, message]);
          if (result.Error) {
            errorSheet.addRow([processedAt, rowNumber, patientName || "N/A", medicareNumber || "N/A", result.Error]);
          }
          await context.emit({ type: "eligibility_noridian_result", rowIndex: rowNumber, update: { __rowKey: String(rowNumber), ...result } });
          completed += 1;
          await context.emit({ type: "progress", completed, total: rowNumbers.length, currentRow: rowNumber });
          if (context.isCancelled?.()) break;
          const newLookup = page.getByText("Eligibility or MBI Lookup", { exact: false }).first();
          if (await newLookup.isVisible({ timeout: 1000 }).catch(() => false)) await openLookup(page);
        }
        styleLogSheet(auditSheet);
        styleLogSheet(errorSheet);
        const output = await workbook.xlsx.writeBuffer();
        await context.emit({ type: "file_download", filename: "medrevenue-noridian-eligibility-output.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: Buffer.from(output).toString("base64") });
        await context.log({ level: "info", message: "MedRevenue Noridian eligibility processing completed and the output workbook was created.", eventName: "eligibility_noridian_complete" });
      } finally {
        await closeAutomationResources({ browser, context: browserContext, page, log: (message) => context.log({ level: "debug", message, eventName: "eligibility_noridian_browser_cleanup" }) });
      }
    },
  };
}
