import type { Locator, Page } from "playwright-core";
import { WAYSTAR_SELECTORS } from "./selectors";
import type { WaystarCredentials, WaystarSecurityQuestion } from "./credentials";
import type { EligibilityInputRow } from "../../types";

export type WaystarInquiryPayload = {
  overallStatus: string;
  sectionStatuses: Array<{
    title: string;
    status: string;
  }>;
};

export type WaystarInquiryDiagnostics = {
  pageUrl: string;
  pageTitle: string;
  payerInputVisible: boolean;
  payerSelectVisible: boolean;
  providerVisible: boolean;
  providerDisabled: boolean;
  serviceTypeVisible: boolean;
  submitVisible: boolean;
  activeCoverageVisible: boolean;
  popupPageCount: number;
  popupUrls: string[];
};

type WaystarSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type WaystarInquirySnapshot = {
  serviceTypeValue: string;
  serviceTypeLabel: string;
  memberId: string;
  lastName: string;
  firstName: string;
  dateOfBirth: string;
};

const WAYSTAR_PAYER_SUGGESTION_SELECTOR = [
  "ul.ui-autocomplete li:visible",
  "li.ui-menu-item:visible",
  ".ui-autocomplete li:visible",
].join(", ");

export async function loginToWaystar(page: Page, credentials: WaystarCredentials): Promise<void> {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator(WAYSTAR_SELECTORS.login.username).first().waitFor({ state: "visible", timeout: 30000 });
  await page.locator(WAYSTAR_SELECTORS.login.username).fill(credentials.username);
  await page.locator(WAYSTAR_SELECTORS.login.password).fill(credentials.password);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.locator(WAYSTAR_SELECTORS.login.submit).click(),
  ]);

  await handleAdditionalAuthentication(page, credentials.verificationAnswers);

  await page.locator(WAYSTAR_SELECTORS.navigation.eligibility).first().waitFor({
    state: "visible",
    timeout: 30000,
  });
}

export async function openEligibilityInquiry(page: Page): Promise<Page> {
  const existingInquiryPages = page.context().pages().filter((candidate) =>
    candidate !== page && candidate.url().includes("eligibility.zirmed.com/DDE"),
  );
  for (const existingInquiryPage of existingInquiryPages) {
    await existingInquiryPage.close().catch(() => {});
  }
  const popupPromise = page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.locator(WAYSTAR_SELECTORS.navigation.eligibility).first().click(),
  ]);
  const popup = await popupPromise;
  const inquiryPage = popup ?? page;
  await inquiryPage.waitForLoadState("domcontentloaded").catch(() => {});
  await inquiryPage.bringToFront().catch(() => {});
  await waitForInquiryControls(inquiryPage);
  return inquiryPage;
}
export async function submitWaystarInquiry(options: {
  page: Page;
  credentials: WaystarCredentials;
  payerName: string;
  row: EligibilityInputRow;
}): Promise<WaystarInquiryPayload> {
  const { page, credentials, payerName, row } = options;
  const inquiryPage = await openEligibilityInquiry(page);
  const expectedServiceType = normalizeServiceTypeCode(row.serviceType) || credentials.serviceTypeCode;
  const expectedMemberId = row.memberId || row.subscriberId || "";
  const expectedLastName = row.patientLastName || "";
  const expectedFirstName = row.patientFirstName || "";
  const expectedDateOfBirth = normalizeDate(row.dateOfBirth || "");

  await inquiryPage.locator(WAYSTAR_SELECTORS.inquiry.subscriberRadio).check().catch(() => {});
  await selectPayer(inquiryPage, payerName);
  await selectProvider(inquiryPage, credentials);
  await selectServiceType(inquiryPage, expectedServiceType);
  await selectPatientLookup(inquiryPage, "10");
  await waitForPatientFieldsReady(inquiryPage);
  await fillVerifiedText(inquiryPage, WAYSTAR_SELECTORS.inquiry.memberId, expectedMemberId, "Member ID");
  await fillVerifiedText(inquiryPage, WAYSTAR_SELECTORS.inquiry.lastName, expectedLastName, "Last Name");
  await fillVerifiedText(inquiryPage, WAYSTAR_SELECTORS.inquiry.firstName, expectedFirstName, "First Name");
  await fillVerifiedText(inquiryPage, WAYSTAR_SELECTORS.inquiry.dateOfBirth, expectedDateOfBirth, "Date of Birth");
  await verifyInquiryFieldsBeforeSubmit(inquiryPage, {
    serviceTypeCode: expectedServiceType,
    memberId: expectedMemberId,
    lastName: expectedLastName,
    firstName: expectedFirstName,
    dateOfBirth: expectedDateOfBirth,
  });

  await Promise.all([
    inquiryPage.waitForLoadState("networkidle").catch(() => {}),
    inquiryPage.locator(WAYSTAR_SELECTORS.inquiry.submit).click(),
  ]);

  await inquiryPage.locator(WAYSTAR_SELECTORS.inquiry.activeCoverage).first().waitFor({
    state: "visible",
    timeout: 30000,
  });

  return inquiryPage.evaluate((selectors) => {
    const overallStatus = document.querySelector(selectors.inquiry.activeCoverageDom)?.textContent?.trim() || "";
    const sectionStatuses = Array.from(document.querySelectorAll(selectors.inquiry.sectionHeaders)).map((element) => {
      const title = element.querySelector(selectors.inquiry.sectionTitle)?.textContent?.trim() || "";
      const status = element.querySelector(selectors.inquiry.sectionStatus)?.textContent?.trim() || "";
      return { title, status };
    }).filter((entry) => entry.title || entry.status);

    return { overallStatus, sectionStatuses };
  }, {
    inquiry: {
      activeCoverageDom: sanitizeDomSelector(WAYSTAR_SELECTORS.inquiry.activeCoverage),
      sectionHeaders: sanitizeDomSelector(WAYSTAR_SELECTORS.inquiry.sectionHeaders),
      sectionTitle: sanitizeDomSelector(WAYSTAR_SELECTORS.inquiry.sectionTitle),
      sectionStatus: sanitizeDomSelector(WAYSTAR_SELECTORS.inquiry.sectionStatus),
    },
  });
}

export function resolveWaystarSecurityAnswer(
  question: string,
  verificationAnswers: WaystarSecurityQuestion[],
): string | null {
  const normalizedQuestion = normalizeQuestion(question);
  if (!normalizedQuestion) return null;

  const normalizedEntries = verificationAnswers
    .map((entry) => ({
      question: normalizeQuestion(entry.question),
      answer: entry.answer,
    }))
    .filter((entry) => entry.question && entry.answer);

  const directMatch = normalizedEntries.find((entry) => entry.question === normalizedQuestion);
  if (directMatch) return directMatch.answer;

  const partialMatch = normalizedEntries.find((entry) =>
    normalizedQuestion.includes(entry.question) || entry.question.includes(normalizedQuestion),
  );
  return partialMatch?.answer ?? null;
}

export function isExactWaystarPayerMatch(candidate: string, target: string): boolean {
  const normalizedCandidate = normalizePayerSuggestion(candidate);
  const normalizedTarget = normalizePayerSuggestion(target);
  if (normalizedCandidate === normalizedTarget) return true;

  const candidateId = extractWaystarPayerId(candidate);
  const targetId = extractWaystarPayerId(target);
  return Boolean(candidateId && targetId && candidateId === targetId);
}

export function findWaystarServiceTypeOption(
  options: WaystarSelectOption[],
  requestedValue: string,
): WaystarSelectOption | null {
  const normalizedRequestedText = normalizeText(requestedValue);
  const requestedCode = normalizeServiceTypeCode(requestedValue);

  for (const option of options) {
    if (option.disabled) continue;

    const label = option.label.trim();
    const value = option.value.trim();
    if (!label && !value) continue;
    if (/^select code$/i.test(label)) continue;

    const normalizedLabel = normalizeText(label);
    const normalizedValue = normalizeText(value);
    const optionCode = normalizeServiceTypeCode(label) || normalizeServiceTypeCode(value);

    if (normalizedRequestedText && normalizedLabel === normalizedRequestedText) return option;
    if (normalizedRequestedText && normalizedValue === normalizedRequestedText) return option;
    if (requestedCode && optionCode === requestedCode) return option;
  }

  return null;
}

export async function captureWaystarInquiryDiagnostics(page: Page): Promise<WaystarInquiryDiagnostics> {
  const provider = page.locator(WAYSTAR_SELECTORS.inquiry.provider).first();

  return {
    pageUrl: page.url(),
    pageTitle: await page.title().catch(() => ""),
    payerInputVisible: await page.locator(WAYSTAR_SELECTORS.inquiry.payerInput).first().isVisible().catch(() => false),
    payerSelectVisible: await page.locator(WAYSTAR_SELECTORS.inquiry.payerSelect).first().isVisible().catch(() => false),
    providerVisible: await provider.isVisible().catch(() => false),
    providerDisabled: await provider.isDisabled().catch(() => true),
    serviceTypeVisible: await page.locator(WAYSTAR_SELECTORS.inquiry.serviceType).first().isVisible().catch(() => false),
    submitVisible: await page.locator(WAYSTAR_SELECTORS.inquiry.submit).first().isVisible().catch(() => false),
    activeCoverageVisible: await page.locator(WAYSTAR_SELECTORS.inquiry.activeCoverage).first().isVisible().catch(() => false),
    popupPageCount: page.context().pages().length,
    popupUrls: page.context().pages().map((candidate) => candidate.url()).filter(Boolean),
  };
}

async function handleAdditionalAuthentication(
  page: Page,
  verificationAnswers: WaystarSecurityQuestion[],
): Promise<void> {
  const authContainer = page.locator(WAYSTAR_SELECTORS.additionalAuth.container).first();
  const authVisible = await authContainer.isVisible().catch(() => false);
  if (!authVisible) return;

  const questionText = await readAdditionalAuthQuestion(page);
  const answer = resolveWaystarSecurityAnswer(questionText, verificationAnswers);
  if (!answer) {
    throw new Error(`Waystar additional authentication question is not configured in the verification sheet: ${questionText || "unknown question"}`);
  }

  const trustDevice = page.locator(WAYSTAR_SELECTORS.additionalAuth.trustDevice).first();
  if (await trustDevice.isVisible().catch(() => false)) {
    await trustDevice.check().catch(() => {});
  }

  await fillVerifiedText(page, WAYSTAR_SELECTORS.additionalAuth.answer, answer, "Verification Answer");
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.locator(WAYSTAR_SELECTORS.additionalAuth.verify).first().click(),
  ]);
}

async function readAdditionalAuthQuestion(page: Page): Promise<string> {
  const questionLocator = page.locator(WAYSTAR_SELECTORS.additionalAuth.question).first();
  const fromLocator = await questionLocator.textContent().catch(() => "");
  if (fromLocator?.trim()) return fromLocator.trim();

  const fallbackText = await page.locator("body").textContent().catch(() => "") ?? "";
  const match = fallbackText.match(/(what[^\n\r?]*\?|first job\??|dessert\??)/i);
  return match?.[1]?.trim() || "";
}

async function waitForInquiryControls(page: Page): Promise<void> {
  const payerInput = page.locator(WAYSTAR_SELECTORS.inquiry.payerInput).first();
  const payerSelect = page.locator(WAYSTAR_SELECTORS.inquiry.payerSelect).first();

  if (await payerInput.isVisible().catch(() => false)) return;
  if (await payerSelect.isVisible().catch(() => false)) return;

  await Promise.any([
    payerInput.waitFor({ state: "visible", timeout: 30000 }),
    payerSelect.waitFor({ state: "visible", timeout: 30000 }),
  ]);
}

async function selectPayer(page: Page, payerName: string): Promise<void> {
  const payerSelect = page.locator(WAYSTAR_SELECTORS.inquiry.payerSelect).first();
  if (await payerSelect.isVisible().catch(() => false)) {
    await payerSelect.selectOption({ label: payerName }).catch(async () => {
      const options = await payerSelect.locator("option").evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: (node as HTMLOptionElement).value,
          label: node.textContent?.trim() || "",
        })),
      );
      const match = options.find((option) => isExactWaystarPayerMatch(option.label, payerName));
      if (!match?.value) {
        throw new Error(`Waystar payer ${payerName} was not found in the DDE payer dropdown.`);
      }
      await payerSelect.selectOption(match.value);
    });
    await payerSelect.evaluate((element) => {
      const select = element as HTMLSelectElement;
      const onchangeAttr = select.getAttribute("onchange") || "";
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof select.onchange === "function") {
        try {
          select.onchange(new Event("change", { bubbles: true }));
        } catch {}
      }
      if (onchangeAttr) {
        try {
          const fn = new Function(onchangeAttr);
          fn.call(select);
        } catch {}
        const postbackMatch = onchangeAttr.match(/__doPostBack\((?:\'|")([^\'"]+)(?:\'|")\s*,\s*(?:\'|")([^\'"]*)(?:\'|")\)/i);
        const doPostBack = (window as Window & { __doPostBack?: (target: string, argument: string) => void }).__doPostBack;
        if (postbackMatch && typeof doPostBack === "function") {
          try {
            doPostBack(postbackMatch[1], postbackMatch[2]);
          } catch {}
        }
      }
      select.dispatchEvent(new Event("blur", { bubbles: true }));
      select.dispatchEvent(new Event("focusout", { bubbles: true }));
    }).catch(() => {});
    await payerSelect.press("Tab").catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1200);
    const selectedOption = await payerSelect.locator("option:checked").evaluate((node) => ({
      value: (node as HTMLOptionElement | null)?.value || "",
      label: (node as HTMLOptionElement | null)?.textContent?.trim() || "",
    })).catch(() => ({ value: "", label: "" }));
    if (!isExactWaystarPayerMatch(selectedOption.label || selectedOption.value, payerName)) {
      throw new Error(
        `Waystar payer selection did not stick in the DDE dropdown. Expected ${payerName}, found ${selectedOption.label || selectedOption.value || "blank"}.`,
      );
    }
    await waitForProviderReady(page);
    return;
  }
  const payerInput = page.locator(WAYSTAR_SELECTORS.inquiry.payerInput).first();
  if (await payerInput.isVisible().catch(() => false)) {
    await resetWaystarPayerSelection(page);
    await payerInput.scrollIntoViewIfNeeded().catch(() => {});
    await payerInput.click({ clickCount: 3 }).catch(() => {});
    await payerInput.press("Control+A").catch(() => {});
    await payerInput.press("Backspace").catch(() => {});
    await payerInput.fill("").catch(() => {});
    await payerInput.type(payerName, { delay: 40 }).catch(async () => {
      await fillVerifiedText(page, WAYSTAR_SELECTORS.inquiry.payerInput, payerName, "Payer");
    });
    await page.waitForTimeout(750);

    const exactSuggestion = await findExactPayerSuggestion(page, payerName);
    if (exactSuggestion) {
      await exactSuggestion.scrollIntoViewIfNeeded().catch(() => {});
      await exactSuggestion.hover().catch(() => {});
      await exactSuggestion.dispatchEvent("mousedown").catch(() => {});
      await exactSuggestion.click().catch(async () => {
        await exactSuggestion.press("Enter").catch(() => {});
      });
    } else {
      await payerInput.press("ArrowDown").catch(() => {});
      await page.waitForTimeout(250);
      await payerInput.press("Enter").catch(() => {});
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1000);

    const commitState = await readWaystarPayerCommitState(page);
    const providerReady = await isProviderReady(page, 8000);
    if (
      providerReady
      || commitState.inquiryDetailsVisible
      || await isInquiryDetailsReady(page)
      || isExactWaystarPayerMatch(commitState.currentValue, payerName)
      || isExactWaystarPayerMatch(commitState.hiddenPayerId, payerName)
      || isExactWaystarPayerMatch(commitState.selectedPayerId, payerName)
    ) {
      await waitForProviderReady(page);
      return;
    }

    await ensureWaystarPayerCommitted(page, payerName).catch(() => {});
    const fallbackState = await readWaystarPayerCommitState(page);
    if (
      await isInquiryDetailsReady(page)
      || await isProviderReady(page, 5000)
      || fallbackState.inquiryDetailsVisible
      || isExactWaystarPayerMatch(fallbackState.currentValue, payerName)
      || isExactWaystarPayerMatch(fallbackState.hiddenPayerId, payerName)
      || isExactWaystarPayerMatch(fallbackState.selectedPayerId, payerName)
    ) {
      await waitForProviderReady(page);
      return;
    }

    throw new Error(
      `Waystar payer selection did not commit. Expected ${payerName}, found input=${fallbackState.currentValue || "blank"}, hidden=${fallbackState.hiddenPayerId || "blank"}, selected=${fallbackState.selectedPayerId || "blank"}, inquiryVisible=${fallbackState.inquiryDetailsVisible}.`,
    );
  }
  throw new Error("Waystar payer control was not found on the DDE inquiry page.");
}
async function findExactPayerSuggestion(page: Page, payerName: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const suggestions = page.locator(WAYSTAR_PAYER_SUGGESTION_SELECTOR);
    const count = await suggestions.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const suggestion = suggestions.nth(index);
      const label = (await suggestion.innerText().catch(() => "")).trim();
      if (isExactWaystarPayerMatch(label, payerName)) {
        return suggestion;
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

type WaystarPayerCommitState = {
  currentValue: string;
  hiddenPayerId: string;
  selectedPayerId: string;
  inquiryDetailsVisible: boolean;
  noPayerVisible: boolean;
};

async function resetWaystarPayerSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const payerInput = document.querySelector("#payerText") as HTMLInputElement | null;
    const hiddenPayer = document.querySelector("#hdnPayerId") as HTMLInputElement | null;
    const selectedPayer = document.querySelector("#SelectedPayerId") as HTMLInputElement | null;
    if (payerInput) payerInput.value = "";
    if (hiddenPayer) hiddenPayer.value = "";
    if (selectedPayer) selectedPayer.value = "";
  }).catch(() => {});
}

async function ensureWaystarPayerCommitted(page: Page, payerName: string): Promise<void> {
  const targetPayerId = extractWaystarPayerId(payerName);
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    const commitState = await readWaystarPayerCommitState(page);
    const exactInputMatch = isExactWaystarPayerMatch(commitState.currentValue, payerName);
    const exactHiddenMatch = isExactWaystarPayerMatch(commitState.hiddenPayerId, payerName)
      || (targetPayerId && commitState.hiddenPayerId.toLowerCase() === targetPayerId);
    const exactSelectedMatch = isExactWaystarPayerMatch(commitState.selectedPayerId, payerName)
      || (targetPayerId && commitState.selectedPayerId.toLowerCase() === targetPayerId);

    if ((exactHiddenMatch || exactSelectedMatch) && commitState.inquiryDetailsVisible && !commitState.noPayerVisible) {
      return;
    }

    if (targetPayerId && (!exactHiddenMatch || !exactSelectedMatch || commitState.noPayerVisible)) {
      await page.evaluate(({ payerId, payerLabel }) => {
        const payerInput = document.querySelector("#payerText") as HTMLInputElement | null;
        const hiddenPayer = document.querySelector("#hdnPayerId") as HTMLInputElement | null;
        const selectedPayer = document.querySelector("#SelectedPayerId") as HTMLInputElement | null;
        const windowWithPayer = window as Window & {
          _inquiryPayerId?: string;
          refreshPayerData?: boolean;
          utility?: { refreshPayerData?: () => void };
        };

        if (payerInput) payerInput.value = payerLabel;
        if (hiddenPayer) hiddenPayer.value = payerId;
        if (selectedPayer) selectedPayer.value = payerId;
        windowWithPayer._inquiryPayerId = payerId;
        windowWithPayer.refreshPayerData = true;
        windowWithPayer.utility?.refreshPayerData?.();
      }, { payerId: targetPayerId, payerLabel: payerName }).catch(() => {});
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
  }

  throw new Error(`Exact Waystar payer commit was not observed for ${payerName}.`);
}

async function readWaystarPayerCommitState(page: Page): Promise<WaystarPayerCommitState> {
  return page.evaluate(() => {
    const payerInput = document.querySelector("#payerText") as HTMLInputElement | null;
    const hiddenPayer = document.querySelector("#hdnPayerId") as HTMLInputElement | null;
    const selectedPayer = document.querySelector("#SelectedPayerId") as HTMLInputElement | null;
    const inquiryDetails = document.querySelector("#inqDetails") as HTMLElement | null;
    const noPayer = document.querySelector(".contentContainer.nopayer") as HTMLElement | null;
    const isVisible = (element: HTMLElement | null) => Boolean(element && element.style.display !== "none");

    return {
      currentValue: payerInput?.value?.trim() || "",
      hiddenPayerId: hiddenPayer?.value?.trim() || "",
      selectedPayerId: selectedPayer?.value?.trim() || "",
      inquiryDetailsVisible: isVisible(inquiryDetails),
      noPayerVisible: isVisible(noPayer),
    };
  });
}


async function waitForProviderReady(page: Page, timeoutMs = 30000): Promise<void> {
  if (await isInquiryDetailsReady(page)) return;
  const provider = page.locator(WAYSTAR_SELECTORS.inquiry.provider).first();
  await provider.waitFor({ state: "visible", timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isInquiryDetailsReady(page)) return;
    const disabled = await provider.isDisabled().catch(() => true);
    if (!disabled) return;
    await page.waitForTimeout(250);
  }
  throw new Error("Waystar provider field did not become active after selecting the payer.");
}
async function isInquiryDetailsReady(page: Page): Promise<boolean> {
  const provider = page.locator(WAYSTAR_SELECTORS.inquiry.provider).first();
  const serviceType = page.locator(WAYSTAR_SELECTORS.inquiry.serviceType).first();
  const noPayer = page.locator('.contentContainer.nopayer').first();
  const providerVisible = await provider.isVisible().catch(() => false);
  const serviceTypeVisible = await serviceType.isVisible().catch(() => false);
  const noPayerVisible = await noPayer.isVisible().catch(() => false);
  return providerVisible && serviceTypeVisible && !noPayerVisible;
}
async function isProviderReady(page: Page, timeoutMs = 5000): Promise<boolean> {
  try {
    await waitForProviderReady(page, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function selectServiceType(page: Page, serviceTypeCode: string): Promise<void> {
  const serviceType = page.locator(WAYSTAR_SELECTORS.inquiry.serviceType).first();
  await serviceType.waitFor({ state: "visible", timeout: 30000 });
  await serviceType.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(250);
  await waitForEnabled(serviceType, "Waystar service type");

  const deadline = Date.now() + 30000;
  let matchingOption: WaystarSelectOption | null = null;
  let latestOptions: WaystarSelectOption[] = [];
  while (Date.now() < deadline) {
    latestOptions = await serviceType.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        value: (node as HTMLOptionElement).value,
        label: node.textContent?.trim() || "",
        disabled: (node as HTMLOptionElement).disabled,
      })),
    );
    matchingOption = findWaystarServiceTypeOption(latestOptions, serviceTypeCode);
    if (matchingOption) break;
    await page.waitForTimeout(250);
  }

  if (!matchingOption) {
    const availableLabels = latestOptions
      .map((option) => option.label)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Waystar service type ${serviceTypeCode} was not available in the dropdown. Available options: ${availableLabels || "none"}.`,
    );
  }

  if (matchingOption.value) {
    await serviceType.selectOption(matchingOption.value);
  } else {
    await serviceType.selectOption({ label: matchingOption.label });
  }

  await serviceType.evaluate((element) => {
    const input = element as HTMLSelectElement;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }).catch(() => {});
  await clickAddCodeIfVisible(page);

  const selectedOption = await serviceType.locator("option:checked").evaluate((node) => ({
    value: (node as HTMLOptionElement | null)?.value || "",
    label: (node as HTMLOptionElement | null)?.textContent?.trim() || "",
  })).catch(() => ({ value: "", label: "" }));

  if (!findWaystarServiceTypeOption([selectedOption], serviceTypeCode)) {
    throw new Error(
      `Waystar service type selection did not stick. Expected ${serviceTypeCode}, found ${selectedOption.label || selectedOption.value || "blank"}.`,
    );
  }
}

async function selectPatientLookup(page: Page, lookupValue: string): Promise<void> {
  const patientLookup = page.locator(WAYSTAR_SELECTORS.inquiry.patientLookup).first();
  await patientLookup.waitFor({ state: "visible", timeout: 30000 });
  await waitForEnabled(patientLookup, "Waystar patient lookup");
  await patientLookup.selectOption(lookupValue);
  await patientLookup.evaluate((element) => {
    const select = element as HTMLSelectElement;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(new Event("blur", { bubbles: true }));
  }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(250);
}
async function waitForPatientFieldsReady(page: Page, timeoutMs = 15000): Promise<void> {
  const memberId = page.locator(WAYSTAR_SELECTORS.inquiry.memberId).first();
  await memberId.waitFor({ state: "visible", timeout: timeoutMs });
  await waitForTextFieldReady(memberId, "Waystar Member ID", timeoutMs);
}
async function waitForTextFieldReady(locator: Locator, label: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const disabled = await locator.isDisabled().catch(() => true);
    const readonly = await locator.evaluate((element) => (element as HTMLInputElement).readOnly).catch(() => true);
    if (!disabled && !readonly) return;
    await locator.page().waitForTimeout(250);
  }
  throw new Error(`${label} did not become editable.`);
}
async function clickAddCodeIfVisible(page: Page): Promise<void> {
  const addCode = page.getByText("Add Code", { exact: true }).first();
  if (!(await addCode.isVisible().catch(() => false))) return;

  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    addCode.click(),
  ]).catch(async () => {
    await addCode.click().catch(() => {});
  });
  await page.waitForTimeout(500);
}

async function fillVerifiedText(page: Page, selector: string, value: string, label: string): Promise<void> {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 30000 });
  await waitForTextFieldReady(input, `Waystar ${label}`);
  await input.fill("").catch(() => {});
  await input.fill(value).catch(() => {});
  await input.evaluate((element, nextValue) => {
    const field = element as HTMLInputElement;
    const prototype = Object.getPrototypeOf(field) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(field, nextValue);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value).catch(() => {});
  await page.waitForTimeout(150);
  const actualValue = await input.inputValue().catch(() => "");
  if (actualValue.trim() !== value.trim()) {
    throw new Error(`Waystar ${label} did not fill correctly. Expected ${value}, found ${actualValue || "blank"}.`);
  }
}

async function verifyInquiryFieldsBeforeSubmit(
  page: Page,
  expected: {
    serviceTypeCode: string;
    memberId: string;
    lastName: string;
    firstName: string;
    dateOfBirth: string;
  },
): Promise<void> {
  const snapshot = await readInquirySnapshot(page);
  const missing: string[] = [];

  if (!findWaystarServiceTypeOption([
    { value: snapshot.serviceTypeValue, label: snapshot.serviceTypeLabel },
  ], expected.serviceTypeCode)) {
    missing.push(`serviceType=${snapshot.serviceTypeLabel || snapshot.serviceTypeValue || "blank"}`);
  }
  if (snapshot.memberId.trim() !== expected.memberId.trim()) {
    missing.push(`memberId=${snapshot.memberId || "blank"}`);
  }
  if (snapshot.lastName.trim() !== expected.lastName.trim()) {
    missing.push(`lastName=${snapshot.lastName || "blank"}`);
  }
  if (snapshot.firstName.trim() !== expected.firstName.trim()) {
    missing.push(`firstName=${snapshot.firstName || "blank"}`);
  }
  if (snapshot.dateOfBirth.trim() !== expected.dateOfBirth.trim()) {
    missing.push(`dateOfBirth=${snapshot.dateOfBirth || "blank"}`);
  }

  if (missing.length > 0) {
    throw new Error(`Waystar inquiry fields were not present on the page before submit. ${missing.join(", ")}.`);
  }
}

async function readInquirySnapshot(page: Page): Promise<WaystarInquirySnapshot> {
  const serviceType = page.locator(WAYSTAR_SELECTORS.inquiry.serviceType).first();
  const selectedService = await serviceType.locator("option:checked").evaluate((node) => ({
    value: (node as HTMLOptionElement | null)?.value || "",
    label: (node as HTMLOptionElement | null)?.textContent?.trim() || "",
  })).catch(() => ({ value: "", label: "" }));

  return {
    serviceTypeValue: selectedService.value,
    serviceTypeLabel: selectedService.label,
    memberId: await page.locator(WAYSTAR_SELECTORS.inquiry.memberId).first().inputValue().catch(() => ""),
    lastName: await page.locator(WAYSTAR_SELECTORS.inquiry.lastName).first().inputValue().catch(() => ""),
    firstName: await page.locator(WAYSTAR_SELECTORS.inquiry.firstName).first().inputValue().catch(() => ""),
    dateOfBirth: await page.locator(WAYSTAR_SELECTORS.inquiry.dateOfBirth).first().inputValue().catch(() => ""),
  };
}

async function selectProvider(page: Page, credentials: WaystarCredentials): Promise<void> {
  const provider = page.locator(WAYSTAR_SELECTORS.inquiry.provider).first();
  await provider.waitFor({ state: "visible", timeout: 30000 });
  if (credentials.providerId) {
    await provider.selectOption(credentials.providerId);
    return;
  }
  if (credentials.providerName) {
    await provider.selectOption({ label: credentials.providerName }).catch(async () => {
      const normalizedTarget = normalizeText(credentials.providerName || "");
      const options = await provider.locator("option").evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: (node as HTMLOptionElement).value,
          label: node.textContent?.trim() || "",
        })),
      );
      const match = options.find((option) => normalizeText(option.label) === normalizedTarget);
      if (!match?.value) {
        throw new Error(`Waystar provider ${credentials.providerName} was not found in the inquiry form.`);
      }
      await provider.selectOption(match.value);
    });
  }
}

function normalizeServiceTypeCode(value?: string): string | null {
  const text = (value || "").trim();
  if (!text) return null;
  const match = text.match(/^([A-Za-z0-9]{1,3})\b/);
  return match ? match[1].toUpperCase() : null;
}

export function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return trimmed;
  const [, month, day, year] = match;
  const normalizedYear = year.length === 2
    ? resolveTwoDigitYear(year)
    : year;
  return `${String(Number(month)).padStart(2, "0")}/${String(Number(day)).padStart(2, "0")}/${normalizedYear}`;
}

function resolveTwoDigitYear(twoDigitYear: string): string {
  const numericYear = Number(twoDigitYear);
  if (Number.isNaN(numericYear)) return twoDigitYear;

  const currentTwoDigitYear = new Date().getUTCFullYear() % 100;
  const century = numericYear > currentTwoDigitYear ? 1900 : 2000;
  return String(century + numericYear);
}
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function normalizeQuestion(value: string): string {
  return normalizeText(value)
    .replace(/\bwhat was\b/g, "")
    .replace(/\bwhat is\b/g, "")
    .replace(/\bwhat was your\b/g, "")
    .replace(/\bwhat is your\b/g, "")
    .trim();
}

function normalizePayerSuggestion(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractWaystarPayerId(value: string): string {
  const match = value.match(/\(([a-z]?\d{4,})\)\s*$/i);
  return match?.[1]?.toLowerCase() || "";
}

function sanitizeDomSelector(selector: string): string {
  return selector.replace(/:visible/g, "");
}

async function waitForEnabled(locator: Locator, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const disabled = await locator.isDisabled().catch(() => true);
    if (!disabled) return;
    await locator.page().waitForTimeout(250);
  }

  throw new Error(`${label} did not become enabled.`);
}







