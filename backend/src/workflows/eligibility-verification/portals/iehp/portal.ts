import type { Locator, Page } from "playwright-core";
import type { EligibilityInputRow, EligibilityResult } from "../../types";
import { normalizeWaystarDate } from "../waystar/dates";

export const selectors = {
  username: "#username", password: "#password",
  // Result pages also contain a Back to Search Results link to the same state.
  // Only the supplied navigation link carries ui-sref-active="active".
  eligibility: 'a[ui-sref="eligibility"][href="/eligibility"][ui-sref-active="active"]',
  search: '#search[ng-model="model.input"]',
  calendar: 'datepicker, [datepicker], [data-datepicker], [x-datepicker]',
  calendarHeader: '._720kb-datepicker-calendar-header-middle._720kb-datepicker-calendar-month',
  labels: '.elig-label:visible',
};

export async function loginIehp(page: Page, credentials: { loginUrl: string; username: string; password: string }) {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded" });
  await page.locator(selectors.username).fill(credentials.username);
  await page.locator(selectors.password).fill(credentials.password);
  await page.getByRole("button", { name: "Log In", exact: true }).click();
  await page.locator(selectors.eligibility).waitFor({ state: "visible", timeout: 60_000 });
  await page.locator(selectors.eligibility).click();
  await page.locator(selectors.search).waitFor({ state: "visible" });
  await page.locator(selectors.search).scrollIntoViewIfNeeded();
  return page.url();
}

async function selectCalendarDos(page: Page, control: Locator, dos: string) {
  await control.click();
  const header = page.locator(`${selectors.calendarHeader}:visible`);
  await header.waitFor({ state: 'visible' });
  const calendar = header.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " _720kb-datepicker-calendar ")][1]');
  if (await calendar.count() !== 1) throw new Error('IEHP DOS calendar could not be identified after opening the date control.');
  const [month, day, year] = dos.split('/').map(Number);
  const targetMonth = year * 12 + month - 1;
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  for (let step = 0; step < 120; step++) {
    const text = (await header.innerText()).replace(/\s+/g, ' ').trim();
    const match = text.match(/([A-Za-z]+)\s+(\d{4})/);
    const index = match ? months.indexOf(match[1].toLowerCase()) : -1;
    if (!match || index < 0) throw new Error('IEHP DOS calendar month could not be read.');
    const currentMonth = Number(match[2]) * 12 + index;
    if (currentMonth === targetMonth) {
      const date = calendar.locator('._720kb-datepicker-calendar-day').filter({ hasText: new RegExp(`^\\s*${day}\\s*$`) });
      if (await date.count() !== 1 || await date.evaluate(el => el.matches('[disabled], [aria-disabled="true"], ._720kb-datepicker-disabled, ._720kb-datepicker-calendar-day-disabled'))) {
        throw new Error('Requested IEHP DOS is unavailable or ambiguous in the calendar.');
      }
      await date.click();
      return;
    }
    const direction = currentMonth > targetMonth ? 'left' : 'right';
    await calendar.locator(`._720kb-datepicker-calendar-header-${direction} a`).click();
    await page.waitForFunction(({ selector, previous }) => Array.from(document.querySelectorAll(selector)).some(el => el.getClientRects().length && el.textContent?.replace(/\s+/g, ' ').trim() !== previous), { selector: selectors.calendarHeader, previous: text });
  }
  throw new Error('Requested IEHP DOS exceeds the supported calendar navigation range.');
}

export async function setIehpDos(page: Page, value: string, timeoutMs = 15_000) {
  const dos = normalizeWaystarDate(value);
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dos)) throw new Error("IEHP requires a valid DOS.");
  // Angular datepicker supports both element and attribute directives. Its
  // calendar header may not exist until the user opens the calendar.
  const form = page.locator('form').filter({ has: page.locator(selectors.search) });
  const scope = await form.count() === 1 ? form : page.locator('body');
  const widgetInputs = scope.locator(selectors.calendar).locator('input:not([type="hidden"]):not(#search)');
  const dosName = /\bDOS\b|date\s*of\s*service|service\s*date|eligibility\s*date/i;
  const labeled = scope.getByLabel(dosName).and(page.locator('input'));
  const described = scope.locator('input').filter({ visible: true }).and(page.locator(
    'input[id*="dos" i], input[name*="dos" i], input[ng-model*="serviceDate" i], input[ng-model*="dateOfService" i], input[placeholder*="date of service" i]',
  ));
  // The portal may render DOS as a clickable date, rather than an editable
  // input. Restrict that fallback to the immediate container of the DOS label.
  const dosLabel = scope.getByText(/^\s*DOS\s*:?\s*$/);
  const displayedDate = dosLabel.locator('..').getByText(/^\s*\d{1,2}\/\d{1,2}\/\d{4}\s*$/);
  const candidates = widgetInputs.or(labeled).or(described).or(displayedDate).and(page.locator(':visible'));
  await candidates.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {
    throw new Error("IEHP Eligibility opened, but its DOS input was not found. Provide the DOS input HTML and its surrounding datepicker element.");
  });
  // Prefer an explicit DOS label if more than one datepicker exists (e.g. DOB).
  const explicit = labeled.or(described).and(page.locator(':visible'));
  const input = await explicit.count() === 1 ? explicit : candidates;
  if (await input.count() !== 1) throw new Error("IEHP Eligibility opened, but multiple possible DOS inputs were found. Provide the DOS input HTML.");
  await input.scrollIntoViewIfNeeded();
  const editableInput = await input.evaluate(el => el.tagName === 'INPUT' && !(el as HTMLInputElement).readOnly);
  const inputType = await input.getAttribute('type');
  const [month, day, year] = dos.split('/');
  if (editableInput) {
    await input.fill(inputType === 'date' ? `${year}-${month}-${day}` : dos);
    await input.press("Tab");
  } else {
    await selectCalendarDos(page, input, dos);
  }
  const retained = normalizeWaystarDate(await input.evaluate(el => el.tagName === 'INPUT' ? (el as HTMLInputElement).value : el.textContent || ''));
  if (retained !== dos) throw new Error("IEHP did not retain the requested DOS.");
}

export async function extractIehpResult(page: Page, rowIndex: number): Promise<EligibilityResult> {
  const data = await page.locator(selectors.labels).evaluateAll((labels) => {
    // Array destructuring avoids tsx's function-name helper inside browser code.
    const [clean, visible] = [
      (text: string | null) => (text || "").replace(/\s+/g, " ").trim(),
      (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
    ] as const;
    const fields: Record<string, string> = {};
    for (const name of ["Plan", "Eff. Date", "OHC", "Medicare ID", "IPA", "Hospital"]) {
      const matches = labels.filter((label) => clean(label.textContent) === name);
      // Medicare ID is not displayed on every member's response. Its absence
      // must not discard otherwise valid coverage and plan information.
      if (name === "Medicare ID" && matches.length === 0) {
        fields[name] = "";
        continue;
      }
      if (matches.length !== 1) throw new Error(`IEHP result field is missing or ambiguous: ${name}.`);
      const sibling = matches[0].nextElementSibling;
      if (!sibling || sibling.matches(".elig-label") || !visible(sibling)) throw new Error(`Cannot identify IEHP value for ${name}.`);
      fields[name] = clean(sibling.textContent);
    }
    // Locate the smallest visible Status label; inspect only its own dot or
    // immediate adjacent indicator, never an unrelated green/red page element.
    const statusLabels = Array.from(document.querySelectorAll("div, span, strong, b, label"))
      .filter((el) => visible(el) && /^Status\s*[●•]?\s*:?$/i.test(clean(el.textContent)))
      .filter((el) => !Array.from(el.children).some((child) => /^Status\s*:?$/i.test(clean(child.textContent))));
    if (statusLabels.length !== 1) throw new Error("IEHP Status label is missing or ambiguous.");
    const label = statusLabels[0];
    const adjacent = label.nextElementSibling;
    const candidates = [label, ...Array.from(label.querySelectorAll("*")), ...(adjacent ? [adjacent, ...Array.from(adjacent.querySelectorAll("*"))] : [])];
    const colors = new Set<string>();
    const [classify] = [(color: string) => {
      const rgb = color.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
      if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) === 0)) return;
      const [r, g, b] = rgb.slice(1, 4).map(Number);
      if (g >= 60 && g > r * 1.3 && g > b * 1.3) colors.add("active");
      if (r >= 60 && r > g * 1.3 && r > b * 1.3) colors.add("inactive");
    }];
    for (const element of candidates.filter(visible)) {
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        if (pseudo && (!style.content || ["none", "normal"].includes(style.content))) continue;
        const rect = element.getBoundingClientRect();
        const width = pseudo ? parseFloat(style.width) : rect.width;
        const height = pseudo ? parseFloat(style.height) : rect.height;
        const round = /%/.test(style.borderRadius) ? parseFloat(style.borderRadius) >= 40 : parseFloat(style.borderRadius) >= Math.min(width, height) * 0.4;
        const compact = width > 0 && height > 0 && width <= 24 && height <= 24 && width / height > 0.7 && width / height < 1.4;
        const glyph = /[●•\uf111]/.test(pseudo ? style.content : clean(element.textContent)) || element.classList.contains("fa-circle");
        if (compact && round) classify(style.backgroundColor);
        if (glyph) classify(style.color);
        if (element.tagName.toLowerCase() === "circle") classify(style.fill);
      }
    }
    if (colors.size !== 1) throw new Error("IEHP Status dot color is missing, unsupported, or ambiguous.");
    return { fields, status: [...colors][0] as "active" | "inactive" };
  });
  return { rowIndex, payerId: "iehp", coverageStatus: data.status, planName: data.fields.Plan,
    effectiveDate: data.fields["Eff. Date"], ipa: data.fields.IPA, benefits: [],
    metadata: { ohc: data.fields.OHC, medicareId: data.fields["Medicare ID"], hospital: data.fields.Hospital } };
}

export async function verifyIehpRow(page: Page, inquiryUrl: string, row: EligibilityInputRow, report: (message: string) => Promise<void> = async () => {}) {
  const search = row.memberId || row.subscriberId || row.patientLastName;
  if (!search || !row.dateOfService) throw new Error("IEHP ID, SSN, CIN, or last name and DOS are required.");
  // Use IEHP's supplied Angular reload link between patients, preserving the
  // authenticated application instead of hard-reloading the document per row.
  if (page.url() !== inquiryUrl || await page.locator(selectors.labels).count() || await page.locator(selectors.search).inputValue()) {
    await page.locator(selectors.eligibility).click();
    await page.waitForFunction(selector => (document.querySelector(selector) as HTMLInputElement | null)?.value === '', selectors.search);
  }
  await report('Scrolling to the IEHP member search panel.');
  await page.locator(selectors.search).scrollIntoViewIfNeeded();
  await page.locator(selectors.search).fill(search);
  await page.locator(selectors.search).press("Tab");
  await report('Member search entered. Setting the requested DOS.');
  await setIehpDos(page, row.dateOfService);
  if (await page.locator(selectors.labels).filter({ hasText: /^Plan$/ }).count()) throw new Error("IEHP inquiry contains a stale result before search.");
  await report('DOS verified. Clicking IEHP Search.');
  const searchButton = page.getByRole("button", { name: "Search", exact: true });
  await searchButton.scrollIntoViewIfNeeded();
  await searchButton.click();
  await page.locator(selectors.labels).filter({ hasText: /^\s*Hospital\s*$/ }).waitFor({ state: "visible", timeout: 60_000 });
  await report('IEHP result loaded. Extracting coverage and plan fields.');
  return extractIehpResult(page, row.originalIndex);
}
