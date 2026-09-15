import type { Locator, Page } from "playwright-core";
import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import type { AutomationContext } from "../../../types";
import type { EligibilityInputRow, EligibilityResult } from "../../types";
import { normalizeWaystarDate } from "../waystar/dates";
import { matchTriZettoPayer, value, type readTriZettoCredentials } from "./data";

// Markdown-escaped underscores in the supplied HTML are literal underscores in the DOM.
const payerField = "#EligibilityRequestPayerInquiry_EligibilityRequestFieldValues_";
const subscriberField = "#EligibilityRequestTemplateInquiry_EligibilityRequestFieldValues_";
export const selectors = {
  username: "#UserName", password: "#Password", login: "#login-button",
  managePatients: "#NavCtrl_navManagePatients", eligibility: "#NavCtrl_hlEligibility",
  inquiry: 'a.toggleLink[href$="/ManagePatients/RealTimeEligibility/Index"]',
  payerRows: "#Insurers li.payer-row", status: "#trnEligibilityStatus",
  dos: `${payerField}DateOfService`, dosEnd: `${payerField}DateOfServiceEnd`,
  subscriberId: `${subscriberField}InsuranceNum`, firstName: `${subscriberField}InsuredFirstName`,
  lastName: `${subscriberField}InsuredLastName`, dob: `${subscriberField}InsuredDob`,
  errors: ".validation-summary-errors:visible, .field-validation-error:visible, [role=alert]:visible",
} as const;

export async function submitTriZettoCode(page: Page, otp: Locator, code: string, timeoutMs = 10_000) {
  const enteredCode = code.trim();
  if (!enteredCode) throw new Error("TriZetto verification code is empty. Enter the code from your email.");
  // TriZetto enables Verify through keyboard validation. fill() alone does not
  // fire keydown/keyup; type each character and leave the field to commit it.
  await otp.fill("");
  await otp.pressSequentially(enteredCode, { delay: 75 });
  await otp.press("Tab");
  if (await otp.inputValue() !== enteredCode) {
    throw new Error("TriZetto did not retain the complete verification code. Request a fresh code and retry.");
  }
  const verify = await page.locator("#btnVerify:visible").count()
    ? page.locator("#btnVerify:visible")
    : page.getByRole("button", { name: /^(verify|submit|continue|verify code)$/i });
  await verify.and(page.locator(":enabled")).waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {
    throw new Error("TriZetto kept Verify disabled after code entry. Check the emailed code or request a fresh code and retry.");
  });
  await verify.click();
}

export async function loginTriZetto(page: Page, credentials: Awaited<ReturnType<typeof readTriZettoCredentials>>, context: AutomationContext) {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded" });
  await page.locator(selectors.username).fill(credentials.username);
  await page.locator(selectors.password).fill(credentials.password);
  await page.locator(selectors.login).click();
  // The masked destination varies by account (including opusBPO addresses).
  // Select the supplied Email table cell, not a hard-coded recipient/domain.
  const email = page.locator("td:visible").filter({ hasText: /^\s*Email\s+\S+@\S+\s*$/i });
  const home = page.locator(`${selectors.managePatients}:visible`);
  await home.or(email).first().waitFor({ state: "visible", timeout: 60_000 });
  if (!(await page.locator(selectors.managePatients).isVisible())) {
    if (await email.count() !== 1) throw new Error("TriZetto email verification destination is ambiguous.");
    await email.click();
    await context.log({ level: "info", message: "Selected TriZetto Email verification. Waiting for the verification code field.", eventName: "eligibility_trizetto_email_selected" });
    // VerifyAuthCode displays "Code" as a placeholder, which is not necessarily
    // an accessible textbox name. Recognize it before requesting frontend input.
    const otp = page.getByRole("textbox", { name: /verification code|security code|one.time.*code|passcode|^code$/i })
      .or(page.getByPlaceholder(/^Code$/i))
      .or(page.locator('input[autocomplete="one-time-code"]'))
      .and(page.locator(":visible"));
    await home.or(otp.and(page.locator(":visible"))).first().waitFor({ state: "visible", timeout: 60_000 });
    if (!(await page.locator(selectors.managePatients).isVisible())) {
      const inputName = `trizetto_otp_${crypto.randomUUID()}`;
      const timeoutMs = 10 * 60 * 1000;
      await context.emit({ type: "otp_request", inputName, label: "TriZetto email verification code", message: "Enter the code from your TriZetto email here, then click Submit code. Verification will continue automatically.", timeoutMs });
      const code = await waitForScrapeJobInput(context.jobId, inputName, timeoutMs);
      await submitTriZettoCode(page, otp, code);
      await context.log({ level: "info", message: "TriZetto verification code entered and Verify clicked.", eventName: "eligibility_trizetto_code_submitted" });
    }
  }
  await page.locator(selectors.managePatients).waitFor({ state: "visible", timeout: 60_000 });
  await page.locator(selectors.managePatients).click();
  await page.locator(selectors.eligibility).click();
  await page.locator(selectors.inquiry).click();
  await page.locator(selectors.payerRows).first().waitFor({ state: "attached" });
  return page.url();
}

export async function selectTriZettoPayer(page: Page, name: string) {
  const rows = page.locator(selectors.payerRows);
  await rows.first().waitFor({ state: "attached" });
  const payers = await rows.evaluateAll((elements) => elements.map((element, index) => ({
    name: element.querySelector("a.payer-selection")?.textContent?.trim() ?? "",
    id: element.querySelector(".payer-selection-id")?.textContent?.trim() ?? "", index,
  })));
  const payer = matchTriZettoPayer(name, payers);
  const row = rows.nth(payer.index);
  if (!(await row.isVisible())) {
    await row.locator("xpath=../..").locator("a.payer-category").click();
  }
  await row.locator("a.payer-selection").click();
  return payer;
}

export function coverageStatus(text: string): EligibilityResult["coverageStatus"] {
  if (/\b(inactive|not active|terminated|no active coverage)\b/i.test(text)) return "inactive";
  if (/\bactive\b/i.test(text)) return "active";
  return "unknown";
}

async function detail(page: Page, label: string) {
  const term = page.locator("dt:visible").filter({ hasText: new RegExp(`^\\s*${label}\\s*:?\\s*$`, "i") });
  const values = await term.locator("xpath=following-sibling::*[1][self::dd]").allTextContents();
  return [...new Set(values.map((entry) => entry.trim()).filter(Boolean))].join(" | ");
}

export async function extractTriZettoResult(page: Page, rowIndex: number, payerId: string): Promise<EligibilityResult> {
  const status = (await page.locator(selectors.status).innerText()).trim();
  const result: EligibilityResult = { rowIndex, payerId: `trizetto:${payerId}`, coverageStatus: coverageStatus(status), planStatus: status,
    planDate: await detail(page, "Plan Begin Date"), effectiveDate: await detail(page, "Eligibility Begin Date"), benefits: [] };
  await page.locator("strong.childtab").filter({ hasText: /^Patient Information$/ }).click();
  result.patientName = (await page.locator("#nadName").innerText()).trim();
  result.relationshipToSubscriber = await detail(page, "Relationship to insured");
  await page.locator("strong.childtab").filter({ hasText: /^Benefit Information$/ }).click();
  const active = page.locator("a.sections").filter({ hasText: /^\s*Active Coverage\s*$/ });
  if (await active.isVisible() && !(await active.evaluate((element) => element.classList.contains("active") || element.getAttribute("aria-expanded") === "true"))) await active.click();
  const benefits = await active.evaluate((heading) => {
    // Stay inside this accordion section. Never treat the outer report/layout
    // table as a benefit table merely because it contains nested headers.
    const scopes: Element[] = [];
    const targetId = heading.getAttribute("aria-controls") || (heading.getAttribute("href")?.startsWith("#") ? heading.getAttribute("href")!.slice(1) : "");
    const target = targetId ? document.getElementById(targetId) : null;
    if (target) scopes.push(target);
    else {
      for (let node: Element | null = heading; node && node !== document.body; node = node.parentElement) {
        for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
          if (sibling.matches("a.sections") || sibling.querySelector("a.sections")) break;
          scopes.push(sibling);
        }
        if (scopes.some((scope) => scope.matches("table") || scope.querySelector("table"))) break;
        scopes.length = 0;
      }
    }
    const tables = [...new Set(scopes.flatMap((scope) => [
      ...(scope.matches("table") ? [scope] : []), ...Array.from(scope.querySelectorAll("table")),
    ]))].filter((table) => table.getClientRects().length && getComputedStyle(table).visibility !== "hidden");
    return tables.flatMap((table) => {
      let serviceIndex = -1;
      let descriptionIndex = -1;
      return Array.from(table.querySelectorAll("tr")).filter((tr) => tr.closest("table") === table).flatMap((tr) => {
        const cells = Array.from(tr.children);
        const texts = cells.map((cell) => {
          const copy = cell.cloneNode(true) as Element;
          copy.querySelectorAll("table, script, style").forEach((child) => child.remove());
          return copy.textContent?.replace(/\s+/g, " ").trim() ?? "";
        });
        if (cells.some((cell) => cell.tagName === "TH")) {
          serviceIndex = texts.indexOf("Service Type");
          descriptionIndex = texts.indexOf("Description");
          return [];
        }
        if (serviceIndex < 0 && descriptionIndex < 0) return [];
        const serviceType = texts[serviceIndex] ?? "";
        const description = texts[descriptionIndex] ?? "";
        return serviceType || description ? [{ serviceType, description }] : [];
      });
    });
  });
  result.benefits = benefits.map((benefit) => ({ serviceType: benefit.serviceType, coverageStatus: result.coverageStatus, notes: benefit.description }));
  result.metadata = { medRevenueOutputServiceType: [...new Set(benefits.map((benefit) => benefit.serviceType).filter(Boolean))].join(" | "),
    trizettoDescription: [...new Set(benefits.map((benefit) => benefit.description).filter(Boolean))].join(" | ") };
  return result;
}

export async function verifyTriZettoRow(page: Page, inquiryUrl: string, row: EligibilityInputRow): Promise<EligibilityResult> {
  const required = [row.subscriberId, row.patientFirstName, row.patientLastName, row.dateOfBirth, row.dateOfService];
  if (required.some((entry) => !entry)) throw new Error("Subscriber ID, first name, last name, DOB, and DOS are required for TriZetto.");
  const dob = normalizeWaystarDate(row.dateOfBirth!);
  const dos = normalizeWaystarDate(row.dateOfService!);
  const dosEnd = normalizeWaystarDate(value(row.raw, ["Date of Service End", "DOS End"]) || row.dateOfService!);
  // A fresh inquiry per row clears old payer, patient, validation and response state.
  await page.goto(inquiryUrl, { waitUntil: "domcontentloaded" });
  const payer = await selectTriZettoPayer(page, value(row.raw, ["Primary Insurance Name"]));
  for (const [selector, entry] of [[selectors.dos, dos], [selectors.dosEnd, dosEnd], [selectors.subscriberId, row.subscriberId!],
    [selectors.firstName, row.patientFirstName!], [selectors.lastName, row.patientLastName!], [selectors.dob, dob]]) {
    await page.locator(selector).fill(entry);
    await page.locator(selector).press("Tab");
  }
  await page.locator("span").filter({ hasText: /^Submit\s+Eligibility\s+Inquiry$/ }).click();
  await page.locator(selectors.status).or(page.locator(selectors.errors).filter({ hasText: /\S/ })).first().waitFor({ state: "visible", timeout: 60_000 });
  const errors = (await page.locator(selectors.errors).allTextContents()).map((text) => text.trim()).filter(Boolean);
  if (errors.length) throw new Error(errors.join(" | "));
  return extractTriZettoResult(page, row.originalIndex, payer.id);
}
