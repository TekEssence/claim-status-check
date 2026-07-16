import type { Page } from "playwright-core";
import type { AstronaClaimDetails, AstronaCredentials, AstronaInputRow, AstronaServiceLine } from "./types";

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function portalName(value: string): string {
  return value.replace(/^\s*\d+\s*[-.:)]\s*/, "").trim();
}

function comparablePortalName(value: string): string {
  return normalize(portalName(value)).replace(/ipa$/, "");
}

async function settle(page: Page, milliseconds = 900): Promise<void> {
  await page.waitForTimeout(milliseconds);
}

async function typeNaturally(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector);
  await field.click();
  await field.press("ControlOrMeta+A");
  await field.pressSequentially(value, { delay: 65 });
}

async function finishAstronaNotices(page: Page): Promise<void> {
  // Astrona can stack payer-specific reminder dialogs over the Claims page.
  // Always operate inside the topmost open dialog so a hidden button behind an
  // overlay is never selected.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const dialogs = page.locator('[role="dialog"]');
    const count = await dialogs.count();
    let handled = false;
    for (let index = count - 1; index >= 0; index -= 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      await dialog.evaluate((element) => {
        const scrollables = [element, ...Array.from(element.querySelectorAll("*"))]
          .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement && candidate.scrollHeight > candidate.clientHeight + 8);
        for (const container of scrollables) container.scrollTop = container.scrollHeight;
      });
      await settle(page, 500);
      const finish = dialog.getByRole("button", { name: /^finish$/i }).or(dialog.locator("button", { hasText: /^\s*finish\s*$/i })).first();
      const acknowledge = dialog.getByRole("button", { name: /^(ok|okay|got it|acknowledge)$/i }).first();
      const action = await finish.count() ? finish : acknowledge;
      if (await action.count() && await action.isEnabled().catch(() => false)) {
        await settle(page, 600);
        await action.scrollIntoViewIfNeeded().catch(() => {});
        await action.click();
        await dialog.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
        await settle(page, 700);
        handled = true;
        break;
      }
    }
    if (!handled) {
      const globalFinish = page.getByRole("button", { name: /^finish$/i }).or(page.locator("button", { hasText: /^\s*finish\s*$/i })).last();
      if (await globalFinish.isVisible().catch(() => false)) {
        await globalFinish.scrollIntoViewIfNeeded().catch(() => {});
        await globalFinish.click({ force: true });
        await settle(page, 800);
        continue;
      }
      return;
    }
  }
}

export function astronaProviderPortalMatches(labelText: string, labelFor: string | null, payer: string): boolean {
  const wanted = comparablePortalName(payer);
  if (!wanted) return false;
  const label = comparablePortalName(labelText);
  const forValue = normalize(labelFor ?? "");
  return (Boolean(label) && (label.includes(wanted) || wanted.includes(label)))
    || (Boolean(forValue) && (forValue === wanted || wanted.startsWith(forValue)));
}

function extractLabel(text: string, labels: string[]): string {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s*[:#-]?\\s*([^\\n|]+)`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

export async function loginToAstrona(page: Page, credentials: AstronaCredentials): Promise<void> {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#email").waitFor({ state: "visible", timeout: 30000 });
  await settle(page, 1200);
  await typeNaturally(page, "#email", credentials.username);
  await settle(page, 500);
  await typeNaturally(page, "#password", credentials.password);
  await settle(page, 800);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.getByRole("button", { name: /^login$/i }).click(),
  ]);
  await page.locator("#email").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  if (await page.locator("#email").isVisible().catch(() => false)) {
    throw new Error("Astrona login did not leave the login page. Verify the payer username and password.");
  }
  await settle(page, 1500);
}

export async function selectAstronaProviderPortal(page: Page, payer: string): Promise<void> {
  const continueButton = page.getByRole("button", { name: /^continue$/i });
  await continueButton.waitFor({ state: "visible", timeout: 30000 }).catch(() => {
    throw new Error(`Astrona provider portal page did not finish loading for Responsible Payer ${payer}.`);
  });

  const labels = page.locator("label");
  const count = await labels.count();
  let selected = false;
  const availableChoices: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    const text = (await label.innerText().catch(() => "")).trim();
    const forId = await label.getAttribute("for");
    if (text) availableChoices.push(text);
    if (astronaProviderPortalMatches(text, forId, payer)) {
      await label.waitFor({ state: "visible", timeout: 10000 });
      await settle(page, 600);
      await label.click();

      if (forId) {
        const control = page.locator(`[id=${JSON.stringify(forId)}]`).first();
        if (await control.count()) {
          const selectionState = async (): Promise<boolean | null> => control.evaluate((element) => {
            if (element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type)) return element.checked;
            const ariaChecked = element.getAttribute("aria-checked");
            if (ariaChecked != null) return ariaChecked === "true";
            const dataState = element.getAttribute("data-state");
            if (dataState != null) return dataState === "checked";
            return null;
          });
          let checked = await selectionState();
          if (checked === false) {
            await control.click();
            checked = await selectionState();
          }
          if (checked === false) throw new Error(`Astrona found payer choice "${text}" but its radio control could not be selected.`);
        }
      }
      selected = true;
      break;
    }
  }
  if (!selected) {
    const choices = availableChoices.length ? availableChoices.join("; ") : "none";
    throw new Error(`Astrona provider portal/IPA was not found for Responsible Payer ${payer}. Visible choices: ${choices}.`);
  }
  await settle(page, 900);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    continueButton.click(),
  ]);
  await settle(page, 1800);
}

export async function goToAstronaClaims(page: Page): Promise<void> {
  await finishAstronaNotices(page);
  const search = page.locator("#memberIdSearch");
  if (await search.isVisible().catch(() => false)) return;

  const candidates = [
    page.getByRole("link", { name: /^claims?$/i }),
    page.getByRole("button", { name: /^claims?$/i }),
    page.getByRole("menuitem", { name: /claims/i }),
    page.locator('a[href*="claim" i], button[data-href*="claim" i]'),
    page.locator("a,button,[role=button]").filter({ hasText: /^\s*claims?\s*$/i }),
    page.locator("svg.lucide-receipt, svg[class*=receipt], [data-lucide=receipt]").locator("xpath=ancestor::*[self::a or self::button or @role='button'][1]"),
  ];

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const target = candidate.first();
      if (await target.isVisible().catch(() => false)) {
        await settle(page, 700);
        await target.click();
        await search.waitFor({ state: "visible", timeout: 30000 });
        await settle(page, 1000);
        await finishAstronaNotices(page);
        return;
      }
    }
    await settle(page, 500);
  }

  const title = await page.title().catch(() => "");
  throw new Error(`Astrona Claims navigation control was not found after 45 seconds (page: ${title || "untitled"}, URL: ${page.url()}).`);
}

export function astronaMemberNameSearchCandidates(memberName: string): string[] {
  const value = memberName.trim();
  if (!value) return [];
  const candidates = [value];
  if (value.includes(",")) {
    const [lastName, givenPart = ""] = value.split(",", 2).map((part) => part.trim());
    const givenNames = givenPart.split(/\s+/).filter(Boolean);
    const withoutInitials = givenNames.filter((part) => part.replace(/[^a-z]/gi, "").length > 1);
    if (lastName && withoutInitials.length) candidates.push(`${lastName}, ${withoutInitials.join(" ")}`);
    if (withoutInitials[0]) candidates.push(withoutInitials[0]);
  } else {
    const parts = value.split(/\s+/).filter(Boolean);
    const withoutInitials = parts.filter((part) => part.replace(/[^a-z]/gi, "").length > 1);
    if (withoutInitials.length > 1) candidates.push(`${withoutInitials[0]} ${withoutInitials.at(-1)}`);
    if (withoutInitials[0]) candidates.push(withoutInitials[0]);
  }
  return Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
}

export async function searchAstronaClaims(page: Page, row: AstronaInputRow, strategy: "both" | "member-name" = "both", searchName = row.memberName): Promise<void> {
  await finishAstronaNotices(page);
  const memberId = page.locator("#memberIdSearch");
  const memberName = page.locator("#patientNameSearch");
  await memberId.fill("");
  await memberName.fill("");
  if (strategy === "both" && row.memberId) await typeNaturally(page, "#memberIdSearch", row.memberId);
  if (strategy === "both" && searchName) {
    await settle(page, 450);
    await typeNaturally(page, "#patientNameSearch", searchName);
  }
  if (strategy === "member-name") {
    if ((await memberId.inputValue()).trim()) await memberId.fill("");
    await typeNaturally(page, "#patientNameSearch", searchName);
  }
  await settle(page, 700);
  if (strategy === "both" && row.memberId) await memberId.press("Enter");
  else await memberName.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await settle(page, 2500);
}

function astronaClaimLinks(page: Page) {
  return page.locator("span.text-brand.cursor-pointer").filter({ hasText: /^\s*(?=[a-z0-9-]*\d)[a-z0-9-]{6,}\s*$/i });
}

async function scrollAstronaResults(page: Page, visit: () => Promise<boolean | void>): Promise<void> {
  // The claims grid may be inside a modal-sized overflow container and may
  // virtualize/lazily-load its rows as you scroll — scrollHeight can grow
  // *after* scrolling starts. Do not budget a fixed number of scroll steps
  // up front; keep scrolling while position or height is still changing.
  const search = page.locator("#memberIdSearch");
  await search.scrollIntoViewIfNeeded().catch(() => {});
  const scrollables = page.locator("body");

  await scrollables.evaluate(() => {
    const all = [document.scrollingElement, ...Array.from(document.querySelectorAll("*"))]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element) => element.scrollHeight > element.clientHeight + 8)
      .sort((left, right) => right.scrollHeight - left.scrollHeight)
      .slice(0, 8);
    for (const element of all) element.scrollTop = 0;
  });

  await settle(page, 80);
  if (await visit()) return;

  let stableRounds = 0;
  // Astrona currently exposes at most the selected rows-per-page (normally
  // ten). A small bounded scan is enough to materialize those rows and avoids
  // spending up to 50 seconds walking unrelated page containers.
  const maxSteps = 12;
  for (let step = 1; step <= maxSteps; step += 1) {
    const { moved, grew } = await scrollables.evaluate(() => {
      const all = [document.scrollingElement, ...Array.from(document.querySelectorAll("*"))]
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
        .filter((element) => element.scrollHeight > element.clientHeight + 8)
        .sort((left, right) => right.scrollHeight - left.scrollHeight)
        .slice(0, 8);
      let changed = false;
      let grew = false;
      for (const element of all) {
        const beforeTop = element.scrollTop;
        const beforeHeight = element.scrollHeight;
        element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(element.clientHeight, 400));
        if (Math.abs(element.scrollTop - beforeTop) > 1) changed = true;
        if (element.scrollHeight > beforeHeight) grew = true;
      }
      return { moved: changed, grew };
    });
    await settle(page, 60);
    if (await visit()) return;
    if (!moved && !grew) {
      stableRounds += 1;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
  }
}

export async function astronaShowsNoClaimResults(page: Page): Promise<boolean> {
  const message = page.getByText(/no\s+(claims?|results?|data)\s+(found|available)|no\s+matching\s+claims?/i).first();
  return message.isVisible().catch(() => false);
}

export async function getAstronaClaimCount(page: Page): Promise<number> {
  if (await astronaShowsNoClaimResults(page)) return 0;
  // Search result presence only; the complete bounded scan happens once in
  // getAstronaClaimNumbersForRow immediately before extraction.
  const visibleCount = await astronaClaimLinks(page).count();
  if (visibleCount) return visibleCount;
  const claimNumbers = new Set<string>();
  await scrollAstronaResults(page, async () => {
    for (const value of await astronaClaimLinks(page).allInnerTexts()) claimNumbers.add(value.trim());
  });
  return claimNumbers.size;
}

export function astronaResultDosMatches(value: string, dos: string): boolean {
  const wanted = canonicalDate(dos);
  if (!wanted) return true;
  const dates = value.match(/\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}/g) ?? [];
  if (dates.some((date) => canonicalDate(date) === wanted)) return true;
  if (dates.length >= 2) {
    const target = Date.parse(`${wanted}T00:00:00Z`);
    const from = Date.parse(`${canonicalDate(dates[0]!)}T00:00:00Z`);
    const to = Date.parse(`${canonicalDate(dates[1]!)}T00:00:00Z`);
    return Number.isFinite(target) && Number.isFinite(from) && Number.isFinite(to) && target >= Math.min(from, to) && target <= Math.max(from, to);
  }
  return false;
}

export async function getAstronaClaimNumbersForRow(page: Page, _inputRow: AstronaInputRow): Promise<string[]> {
  const matches = new Set<string>();
  await scrollAstronaResults(page, async () => {
    const claims = astronaClaimLinks(page);
    for (let index = 0; index < await claims.count(); index += 1) {
      const claim = claims.nth(index);
      const claimNumber = (await claim.innerText().catch(() => "")).trim();
      // Astrona's visual grid can render the claim-number and Date of Service
      // columns in separate virtualized DOM trees. Never reject a returned
      // claim from the summary grid; open it and use detail service lines as
      // the authoritative DOS/CPT source.
      if (claimNumber) matches.add(claimNumber);
    }
  });
  return [...matches];
}

export async function goToNextAstronaClaimsPage(page: Page): Promise<boolean> {
  const next = page
    .locator('a[aria-label="Go to next page"], button[aria-label="Go to next page"], [role=button][aria-label="Go to next page"]')
    .or(page.getByRole("button", { name: /^(next|go to next page)$/i }))
    .or(page.getByRole("link", { name: /^(next|go to next page)$/i }))
    .or(page.locator("button,a,[role=button]").filter({ hasText: /^\s*next\s*$/i }))
    .first();
  if (!await next.isVisible().catch(() => false)) return false;
  const unavailable = await next.evaluate((element) => {
    const control = element as HTMLButtonElement;
    return control.disabled
      || element.getAttribute("aria-disabled") === "true"
      || element.hasAttribute("disabled")
      || element.getAttribute("data-disabled") === "true";
  }).catch(() => true);
  if (unavailable) return false;

  await next.scrollIntoViewIfNeeded().catch(() => {});
  await next.click();
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await settle(page, 300);
  return true;
}

export async function getAstronaClaimIndexesForRow(page: Page, inputRow: AstronaInputRow): Promise<number[]> {
  const wantedDos = canonicalDate(inputRow.dos);

  const claims = astronaClaimLinks(page);
  const indexes: number[] = [];
  for (let index = 0; index < await claims.count(); index += 1) {
    const claim = claims.nth(index);
    const result = await claim.evaluate((element) => {
      const row = element.closest("tr,[role=row]") as HTMLElement | null;
      const table = row?.closest("table,[role=table],[role=grid]");
      const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const headers = Array.from(table?.querySelectorAll("th,[role=columnheader]") ?? []);
      const cells = Array.from(row?.querySelectorAll("td,[role=cell],[role=gridcell]") ?? []);
      const dosHeader = headers.find((header) => ["dateofservice", "servicedate", "dos"].includes(normalizeHeader(header.textContent ?? "")));
      const dosIndex = dosHeader instanceof HTMLTableCellElement ? dosHeader.cellIndex : headers.indexOf(dosHeader as Element);
      return {
        dos: dosIndex >= 0 ? (cells[dosIndex]?.textContent ?? "").trim() : "",
      };
    }).catch(() => ({ dos: "" }));
    const dosMatches = !wantedDos || canonicalDate(result.dos) === wantedDos;
    if (dosMatches) indexes.push(index);
  }
  return indexes;
}

export async function openAstronaClaim(page: Page, index: number): Promise<{ claimNumber: string; originalUrl: string }> {
  const claims = astronaClaimLinks(page);
  const claim = claims.nth(index);
  const claimNumber = (await claim.innerText()).trim();
  const originalUrl = page.url();
  await settle(page, 600);
  await claim.click();
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await settle(page, 1000);
  return { claimNumber, originalUrl };
}

export async function openAstronaClaimByNumber(page: Page, claimNumber: string): Promise<{ claimNumber: string; originalUrl: string }> {
  let target = astronaClaimLinks(page).filter({ hasText: new RegExp(`^\\s*${claimNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") }).first();
  if (!await target.isVisible().catch(() => false)) {
    await scrollAstronaResults(page, async () => target.isVisible().catch(() => false));
    target = astronaClaimLinks(page).filter({ hasText: new RegExp(`^\\s*${claimNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") }).first();
  }
  if (!await target.isVisible().catch(() => false)) throw new Error(`Astrona claim ${claimNumber} disappeared from the results while scrolling.`);
  await target.scrollIntoViewIfNeeded();
  const originalUrl = page.url();
  await target.click();
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await settle(page, 300);
  return { claimNumber, originalUrl };
}

function canonicalDate(value: string): string {
  const text = value.trim();
  const slash = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (slash) {
    const year = slash[3].length === 2 ? Number(slash[3]) + 2000 : Number(slash[3]);
    return `${year}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  }
  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  return iso ? `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}` : normalize(text);
}

export function astronaServiceLinesForDos(serviceLines: AstronaServiceLine[], dos: string): AstronaServiceLine[] {
  const wanted = canonicalDate(dos);
  if (!wanted) return serviceLines;
  return serviceLines.filter((line) => {
    if (canonicalDate(line.from) === wanted || canonicalDate(line.to) === wanted) return true;
    const target = Date.parse(`${wanted}T00:00:00Z`);
    const fromValue = canonicalDate(line.from);
    const toValue = canonicalDate(line.to);
    const from = Date.parse(`${fromValue}T00:00:00Z`);
    const to = Date.parse(`${toValue}T00:00:00Z`);
    return Boolean(fromValue && toValue) && Number.isFinite(target) && Number.isFinite(from) && Number.isFinite(to)
      && target >= Math.min(from, to) && target <= Math.max(from, to);
  });
}

function canonicalProcedureCode(value: string): string {
  const text = value.trim().toUpperCase();
  const code = text.match(/\b(?:[A-Z]\d{4}|\d{5})\b/)?.[0];
  return code ?? normalize(text);
}

export function astronaServiceLinesForDosAndCpt(serviceLines: AstronaServiceLine[], dos: string, cptCode: string): AstronaServiceLine[] {
  const dosMatches = astronaServiceLinesForDos(serviceLines, dos);
  const wantedCpt = canonicalProcedureCode(cptCode);
  if (!wantedCpt) return dosMatches;
  return dosMatches.filter((line) => canonicalProcedureCode(line.cpt) === wantedCpt);
}

function canonicalNameTokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 1 && !["jr", "sr", "ii", "iii", "iv"].includes(token))
    .sort();
}

export function astronaClaimNameMatches(details: AstronaClaimDetails, row: AstronaInputRow): boolean {
  const portalName = details.memberName ?? "";
  if (!row.memberName) return true;
  if (!portalName) return false;
  const wanted = canonicalNameTokens(row.memberName);
  const actual = canonicalNameTokens(portalName);
  if (!wanted.length || !actual.length) return false;
  const wantedInActual = wanted.every((token) => actual.includes(token));
  const actualInWanted = actual.every((token) => wanted.includes(token));
  return wantedInActual || actualInWanted;
}

export function astronaClaimDobMatches(details: AstronaClaimDetails, row: AstronaInputRow): boolean {
  const portalDob = details.memberDob ?? "";
  return !row.dob || (Boolean(portalDob) && canonicalDate(portalDob) === canonicalDate(row.dob));
}

async function scrollAstronaClaimDetails(page: Page): Promise<ReturnType<Page["locator"]>> {
  const openDialogs = page.locator('[role="dialog"][data-state="open"]');
  let root = page.locator("body");
  for (let index = (await openDialogs.count()) - 1; index >= 0; index -= 1) {
    const candidate = openDialogs.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      root = candidate;
      break;
    }
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const reachedBottom = await root.evaluate((element) => {
      const elements = [element, ...Array.from(element.querySelectorAll("*"))]
        .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);
      const horizontal = elements.filter((candidate) => candidate.scrollWidth > candidate.clientWidth + 8);
      for (const container of horizontal) container.scrollLeft = container.scrollWidth;
      const scrollable = elements
        .filter((candidate) => candidate.scrollHeight > candidate.clientHeight + 8)
        .sort((left, right) => right.scrollHeight - left.scrollHeight)[0] as HTMLElement | undefined;
      if (!scrollable) return true;
      scrollable.scrollTop = Math.min(scrollable.scrollHeight, scrollable.scrollTop + Math.max(500, scrollable.clientHeight));
      return scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 8;
    });
    await settle(page, 80);
    if (reachedBottom) break;
  }
  await settle(page, 200);
  return root;
}

export async function extractAstronaClaimDetails(page: Page, fallbackClaimNumber: string): Promise<AstronaClaimDetails> {
  const root = await scrollAstronaClaimDetails(page);
  const bodyText = await root.innerText();
  const serviceLines = await root.locator("table,[role=table],[role=grid]").evaluateAll((tables) => {
    const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const aliases: Record<string, string[]> = {
      from: ["from", "servicefrom", "fromdate"],
      to: ["to", "serviceto", "todate"],
      fromTo: ["fromto", "servicefromto", "fromtodate", "servicedates", "dateofservice", "dos"],
      cpt: ["cpt", "cptcode", "procedure", "procedurecode", "servicecode", "servicescpt", "servicecpt"],
      modifier: ["modifier", "mod"],
      diagCode: ["diagcode", "diagnosiscode", "diagnosis", "dxcode"],
      qty: ["qty", "quantity", "units"],
      billed: ["billed", "billedamount", "charge"],
      coPay: ["copay", "copayamount"],
      coInsure: ["coinsure", "coinsurance", "coinsuranceamount"],
      coPayCoInsure: ["copaycoinsure", "copaycoinsurance", "copaycoinsureamount"],
      deductible: ["deductible", "deduct"],
      adjustment: ["adjustment", "adjusted", "adjustmentamount"],
      net: ["net", "netamount", "netpaid"],
      memoLine1: ["memoline1", "memo1", "memo"],
    };
    const output: Record<string, string>[] = [];
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr,[role=row]"));
      const knownHeaders = new Set(Object.values(aliases).flat());
      const headerCandidates = rows.map((row, rowIndex) => {
        const headers = Array.from(row.querySelectorAll("th,td,[role=columnheader],[role=cell],[role=gridcell]"))
          .map((cell) => normalizeHeader((cell.textContent || "").trim()));
        return { rowIndex, headers, score: headers.filter((header) => knownHeaders.has(header)).length };
      });
      const selectedHeader = headerCandidates.sort((left, right) => right.score - left.score)[0];
      if (!selectedHeader || selectedHeader.score < 2) continue;
      const headers = selectedHeader.headers;
      const indexes = Object.fromEntries(Object.entries(aliases).map(([field, names]) => [field, headers.findIndex((header) => names.includes(header))]));
      if (indexes.cpt < 0 && indexes.net < 0) continue;
      for (const row of rows.slice(selectedHeader.rowIndex + 1)) {
        const cells = Array.from(row.querySelectorAll("td,[role=cell],[role=gridcell]"));
        const line = Object.fromEntries(Object.entries(indexes).map(([field, index]) => [field, index >= 0 ? (cells[index]?.textContent || "").trim() : ""]));
        if (!line.from && !line.to && line.fromTo) {
          const dates = line.fromTo.match(/\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}/g) || [];
          line.from = dates[0] || "";
          line.to = dates[1] || dates[0] || "";
        }
        if (!line.coPay && !line.coInsure && line.coPayCoInsure) {
          const amounts = line.coPayCoInsure.match(/\(?-?\$?\s*\d[\d,]*(?:\.\d+)?\)?/g) || [];
          line.coPay = (amounts[0] || "").replace(/\s+/g, "");
          line.coInsure = (amounts[1] || "").replace(/\s+/g, "");
        }
        delete line.fromTo;
        delete line.coPayCoInsure;
        if (Object.values(line).some(Boolean)) output.push(line);
      }
    }
    return output;
  }) as AstronaServiceLine[];
  const cptCodes = Array.from(new Set(serviceLines.map((line) => line.cpt).filter(Boolean)));
  const labelledServices = extractLabel(bodyText, ["Services (CPT)", "CPT", "Procedure Code"]);
  if (!cptCodes.length && labelledServices) cptCodes.push(...labelledServices.split(/[,;]+/).map((value) => value.trim()).filter(Boolean));
  const claimMemo = extractLabel(bodyText, ["Memo Line 1", "Memo 1"]);
  const claimNet = extractLabel(bodyText, ["Net Amount", "Net Paid", "Paid Amount"]);
  return {
    memberName: extractLabel(bodyText, ["Member Name", "Patient Name", "Member"]),
    memberDob: extractLabel(bodyText, ["Date of Birth", "Member DOB", "Patient DOB", "DOB"]),
    claimNumber: extractLabel(bodyText, ["Claim Number", "Claim #", "Claim No"]) || fallbackClaimNumber,
    datePaid: extractLabel(bodyText, ["Date Paid", "Paid Date"]),
    checkNumber: extractLabel(bodyText, ["Check Number", "Check No", "Check #"]),
    portalStatus: extractLabel(bodyText, ["Claim Status", "Status"]),
    netAmount: claimNet,
    cptCodes,
    memoLine1: claimMemo,
    serviceLines,
  };
}

export async function returnToAstronaResults(page: Page, originalUrl: string): Promise<void> {
  await finishAstronaNotices(page);
  const dialogs = page.locator('[role="dialog"][data-state="open"]');
  let closedDialog = false;
  for (let index = (await dialogs.count()) - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (!(await dialog.isVisible().catch(() => false))) continue;
    const namedClose = dialog.getByRole("button", { name: /^(close|done)$/i }).first();
    const iconClose = dialog.locator("button:has(svg.lucide-x), button:has(svg[class*=lucide-x]), button:has([data-lucide=x])").first();
    const close = await namedClose.isVisible().catch(() => false) ? namedClose : iconClose;
    if (await close.isVisible().catch(() => false)) {
      await settle(page, 150);
      await close.click();
      await dialog.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
      closedDialog = true;
      break;
    }
  }
  if (!closedDialog && page.url() !== originalUrl) await page.goBack({ waitUntil: "domcontentloaded" });
  else if (!closedDialog) await page.keyboard.press("Escape");
  await page.locator("#memberIdSearch").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  await settle(page, 250);
}

export async function signOutAstrona(page: Page): Promise<void> {
  const signOut = page
    .getByRole("button", { name: /sign\s*out|log\s*out/i })
    .or(page.getByRole("link", { name: /sign\s*out|log\s*out/i }))
    .first();

  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click().catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  }

  // Always remove the completed payer session before another credential set is
  // used, including when the portal does not expose a detectable sign-out link.
  await page.context().clearCookies();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }).catch(() => {});
}
