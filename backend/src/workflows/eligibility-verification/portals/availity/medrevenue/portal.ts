import type { Frame, Locator, Page } from "playwright-core";
import type { AvailityProjectConfig } from "../config/projects";
import { BCBS_AVAILITY_ELIGIBILITY_SELECTORS as shared } from "../payers/bcbs/selectors";
import { normalizeWaystarDate } from "../../waystar/dates";
import { matchingMemberIndex, parseMemberSearchResult, type AvailityMemberRow } from "./data";
import { waitForMemberResponseFields } from "./result-fields";

type Scope = Page | Frame;
const defaults: Record<string, string> = {
  ...shared.navigation, ...shared.payerSelection,
  newRequest: shared.results.newRequest,
};

async function find(page: Page, config: AvailityProjectConfig, key: string, timeout = 30_000): Promise<{ scope: Scope; locator: Locator }> {
  const selectors = [config.selectors?.[key], defaults[key], config.selectorFallbacks?.[key]].filter((s): s is string => Boolean(s));
  const deadline = Date.now() + timeout;
  do {
    for (const candidate of page.context().pages().filter(p => !p.isClosed())) {
      for (const scope of candidate.frames()) {
        for (const selector of selectors) {
          const locator = scope.locator(selector).filter({ visible: true }).first();
          if (await locator.isVisible().catch(() => false)) return { scope, locator };
        }
      }
    }
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  throw new Error(`Availity ${key} was not available (portal timeout or session expired).`);
}

export async function selectOption(scope: Scope, field: Locator, value: string, label: string) {
  await field.waitFor({ state: 'visible' });
  const matches = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase() === value.trim().replace(/\s+/g, ' ').toLowerCase();
  // Availity can preselect the payer/state. Filling the same value does not
  // necessarily open MUI suggestions, so do not wait for a redundant option.
  if (matches(await field.inputValue()) && await field.getAttribute('aria-expanded') !== 'true'
    && await field.getAttribute('aria-invalid') !== 'true') return;
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await field.fill('');
  await field.pressSequentially(value, { delay: 70 });
  const option = scope.getByRole("option", { name: value, exact: true }).filter({ visible: true });
  await option.waitFor({ state: "visible", timeout: 15_000 }).catch(() => { throw new Error(`${label} not found: ${value}.`); });
  await option.click();
  if ((await field.inputValue()).trim().toLowerCase() !== value.toLowerCase()) throw new Error(`${label} selection was not retained.`);
}

export async function selectProvider(scope: Scope, field: Locator, name: string, npi: string) {
  // Input text alone does not mean MUI has committed a provider selection.
  // The individual and organization share a Tax ID, so match the NPI too.
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const optionName = new RegExp(`^${escape(name)}\\s*\\(NPI:\\s*${escape(npi)}\\b[^)]*\\)$`, 'i');
  await field.waitFor({ state: 'visible' });
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await field.fill('');
  await field.pressSequentially(name, { delay: 70 });
  const option = scope.getByRole('option', { name: optionName }).filter({ visible: true });
  await option.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
    throw new Error(`Provider not found or ambiguous: ${name} (NPI: ${npi}).`);
  });
  await option.click();
  await option.waitFor({ state: 'hidden', timeout: 10_000 });
  await field.blur();
  const deadline = Date.now() + 5_000;
  do {
    const retained = (await field.inputValue()).trim();
    if ((retained.toLowerCase() === name.toLowerCase() || optionName.test(retained))
      && await field.getAttribute('aria-invalid') !== 'true'
      && await field.getAttribute('aria-expanded') !== 'true') return;
    await scope.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`Provider selection was not retained: ${name} (NPI: ${npi}).`);
}

async function dateGroup(scope: Scope, config: AvailityProjectConfig, label: RegExp, fallback?: Locator): Promise<Locator> {
  // Scope by the field's label first; never use generated MUI IDs.
  const labelled = scope.locator('.MuiFormControl-root').filter({ has: scope.getByText(label, { exact: true }) });
  for (const selector of [config.selectors?.dateGroups, config.selectorFallbacks?.dateGroups]) {
    if (!selector) continue;
    const group = labelled.locator(selector).filter({ visible: true });
    if (await group.count() === 1) return group;
  }
  if (fallback) {
    for (const selector of [config.selectors?.dateGroups, config.selectorFallbacks?.dateGroups]) {
      if (!selector) continue;
      const groups = fallback.locator(selector).filter({ visible: true });
      if (await groups.count() === 1) return groups;
    }
  }
  throw new Error(`Cannot uniquely identify the ${label.source} date control.`);
}

export async function fillSectionDate(group: Locator, value: string) {
  const parts = normalizeWaystarDate(value).split("/");
  for (const [index, label] of ["Month", "Day", "Year"].entries()) {
    const section = group.getByRole("spinbutton", { name: label, exact: true });
    await section.fill(parts[index]);
    await section.press("Tab");
    const retained = await section.getAttribute("aria-valuenow") || await section.textContent();
    if (Number(retained) !== Number(parts[index])) {
      // Some MUI versions commit sections through key events rather than input.
      await section.click();
      await section.pressSequentially(parts[index], { delay: 120 });
      await section.press("Tab");
    }
  }
  for (const [index, label] of ["Month", "Day", "Year"].entries()) {
    const section = group.getByRole("spinbutton", { name: label, exact: true });
    const actual = await section.getAttribute("aria-valuenow") || await section.textContent();
    if (Number(actual) !== Number(parts[index])) throw new Error(`Availity date ${label} was not retained.`);
  }
}

export async function openMemberInquiry(page: Page, config: AvailityProjectConfig): Promise<Scope> {
  // Reset any previous result, including a failed row, before entering another member.
  const newRequest = await find(page, config, "newRequest", 500).catch(() => null);
  if (newRequest) await newRequest.locator.click();
  else {
    await (await find(page, config, "patientRegistration")).locator.click();
    await (await find(page, config, "eligibilityInquiry")).locator.click();
  }
  return (await find(page, config, "payer")).scope;
}

export async function verifyMemberSearchRow(page: Page, row: AvailityMemberRow, config: AvailityProjectConfig, report: (message: string) => Promise<void> = async () => {}) {
  if (config.id !== "medrevenue" || config.inquiryMode !== "member-search" || !config.provider || !config.providerNpi || !config.state) throw new Error("Member search requires MedRevenue Availity configuration.");
  if (!row.memberId?.trim()) throw new Error("Member ID is required.");
  normalizeWaystarDate(row.dateOfBirth || "");
  normalizeWaystarDate(row.dateOfService || "");
  if (!row.dateOfBirth || !row.dateOfService) throw new Error("DOB and DOS are required.");
  await openMemberInquiry(page, config);
  await report('Selecting payer.');
  const payer = await find(page, config, "payer");
  await selectOption(payer.scope, payer.locator, row.portalPayerName, "Payer");
  await report('Payer confirmed. Selecting configured provider.');
  const provider = await find(page, config, "provider");
  await selectProvider(provider.scope, provider.locator, config.provider, config.providerNpi);
  await report('Provider confirmed. Filling Member Search.');
  const tab = await find(page, config, "memberSearch");
  await tab.locator.click();
  if (await tab.locator.getAttribute("aria-selected") !== "true") throw new Error("Member Search tab did not activate.");
  const member = await find(page, config, "memberId");
  await member.locator.fill(row.memberId);
  const panel = member.scope.locator(config.selectors!.memberPanel).filter({ visible: true }).first();
  await fillSectionDate(await dateGroup(member.scope, config, /Date of Birth|DOB/i, panel), row.dateOfBirth);
  const state = await find(page, config, "state");
  await selectOption(state.scope, state.locator, config.state, "State");
  if (await member.locator.inputValue() !== row.memberId) throw new Error("Member ID was not retained.");
  const search = await find(page, config, "search");
  await search.locator.click();
  const resultRows = search.scope.locator(config.selectors!.memberRows).filter({ visible: true });
  await resultRows.first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => { throw new Error("No member search results; check Member ID and DOB."); });
  const cells = await resultRows.evaluateAll(rows => rows.map(row => Array.from(row.querySelectorAll('td, [role="cell"]')).map(cell => cell.textContent?.trim() || "")));
  const selected = matchingMemberIndex(cells, row);
  await resultRows.nth(selected).click();
  // No Submit is attempted before a unique matching member has been selected.
  const submit = await find(page, config, "submit");
  await fillSectionDate(await dateGroup(submit.scope, config, /As of Date/i), row.dateOfService);
  const deadline = Date.now() + 15_000;
  while ((!await submit.locator.isEnabled() || await submit.locator.getAttribute("aria-disabled") === "true" || (await submit.locator.getAttribute("id"))?.includes("disabled")) && Date.now() < deadline) await page.waitForTimeout(200);
  if (!await submit.locator.isEnabled() || await submit.locator.getAttribute("aria-disabled") === "true" || (await submit.locator.getAttribute("id"))?.includes("disabled")) throw new Error("Submit remains disabled after member selection.");
  await submit.locator.click();
  const statusSelector = `${config.selectors!.coverage}:text-matches("coverage|eligible|terminated", "i")`;
  const responseConfig = { ...config, selectors: { ...config.selectors, response: statusSelector } };
  const response = await find(page, responseConfig, "response", 45_000);
  await response.scope.locator('[role="progressbar"]:visible, [aria-busy="true"]:visible').first()
    .waitFor({ state: "hidden", timeout: 30_000 });
  await report('Coverage response received. Reading plan dates and benefit details.');
  // Labels often render before their values arrive.
  const fields = await waitForMemberResponseFields(response.scope);
  return parseMemberSearchResult({ ...fields, status: await response.locator.innerText() }, row);
}
