import type { Locator, Page } from "playwright-core";
import { WAYSTAR_SELECTORS } from "./selectors";
import type { WaystarCredentials, WaystarSecurityQuestion } from "./credentials";
import type { EligibilityInputRow } from "../../types";

export type WaystarBenefitEntry = {
  type?: string;
  value?: string;
  placeOfService?: string;
  payerNote?: string;
  includedProviderSpecialties?: string;
};

export type WaystarBenefitSection = {
  network?: string;
  coverageLevel?: string;
  entries: WaystarBenefitEntry[];
};

export type WaystarInquiryPayload = {
  overallStatus: string;
  sectionStatuses: Array<{ title: string; status: string }>;
  subscriberInformation?: {
    patientName?: string;
    address?: string;
    memberId?: string;
    dateOfBirth?: string;
    sex?: string;
  };
  subscriberCoverageInformation?: {
    groupNumber?: string;
    planDate?: string;
    premiumPaidToDateEnd?: string;
    insuranceType?: string;
  };
  general?: { primaryCareProvider?: string };
  healthBenefitPlanCoverage?: {
    coverageDescription?: string;
    eligibilityBeginDate?: string;
    eligibilityEndDate?: string;
    planStatus?: string;
    planType?: string;
    general?: { coverageDescription?: string };
    benefitSections?: WaystarBenefitSection[];
  };
  professionalOffice?: WaystarBenefitSection[];
};

const WAYSTAR_PAYER_SUGGESTION_SELECTOR = [
  "ul.ui-autocomplete li:visible",
  "li.ui-menu-item:visible",
  ".ui-autocomplete li:visible",
].join(", ");

export async function loginToWaystar(page: Page, credentials: WaystarCredentials): Promise<void> {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator(WAYSTAR_SELECTORS.login.username).first().waitFor({ state: "visible", timeout: 30000 });
  await humanPause(page, 700, 1300);
  await humanType(page.locator(WAYSTAR_SELECTORS.login.username).first(), credentials.username);
  await humanPause(page, 350, 750);
  await humanType(page.locator(WAYSTAR_SELECTORS.login.password).first(), credentials.password);
  await humanPause(page, 500, 1000);
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
  const existingInquiryPage = page.context().pages().find((candidate) =>
    candidate !== page && !candidate.isClosed() && candidate.url().includes("eligibility.zirmed.com/DDE"),
  );
  if (existingInquiryPage) {
    await existingInquiryPage.bringToFront().catch(() => {});
    const changeInquiry = existingInquiryPage.locator(
      WAYSTAR_SELECTORS.inquiry.changeInquiryDetails,
    ).first();
    if (await changeInquiry.isVisible().catch(() => false)) {
      await humanPause(existingInquiryPage, 1200, 2000);
      const editUrl = await changeInquiry.getAttribute("onclick").then((script) => {
        const relativeUrl = script?.match(/OpenDDE\(\s*['"]([^'"]+)['"]/)?.[1];
        return relativeUrl ? new URL(relativeUrl, existingInquiryPage.url()).toString() : null;
      }).catch(() => null);

      if (editUrl) {
        await existingInquiryPage.goto(editUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      } else {
        await changeInquiry.click();
        await existingInquiryPage.waitForLoadState("domcontentloaded").catch(() => {});
      }

      await existingInquiryPage.bringToFront().catch(() => {});
      await waitForInquiryControls(existingInquiryPage);
      await humanPause(existingInquiryPage, 1000, 1800);
      return existingInquiryPage;
    }

    await waitForInquiryControls(existingInquiryPage);
    return existingInquiryPage;
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
  await humanPause(inquiryPage, 650, 1200);
  const expectedServiceType = normalizeServiceTypeCode(row.serviceType) || credentials.serviceTypeCode;
  const expectedMemberId = row.memberId || row.subscriberId || "";
  const expectedLastName = row.patientLastName || "";
  const expectedFirstName = row.patientFirstName || "";
  const expectedDateOfBirth = normalizeDate(row.dateOfBirth || "");

  await inquiryPage.locator(WAYSTAR_SELECTORS.inquiry.subscriberRadio).check().catch(() => {});
  await humanPause(inquiryPage);
  await selectPayer(inquiryPage, payerName);
  await humanPause(inquiryPage);
  await selectProvider(inquiryPage, credentials);
  await humanPause(inquiryPage);
  await selectServiceType(inquiryPage, expectedServiceType);
  await humanPause(inquiryPage);
  await inquiryPage.locator(WAYSTAR_SELECTORS.inquiry.patientLookup).selectOption("10");
  await humanPause(inquiryPage);
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
  await humanPause(inquiryPage, 700, 1300);

  await Promise.all([
    inquiryPage.waitForLoadState("networkidle").catch(() => {}),
    inquiryPage.locator(WAYSTAR_SELECTORS.inquiry.submit).click(),
  ]);

  await inquiryPage.locator(WAYSTAR_SELECTORS.inquiry.activeCoverage).first().waitFor({
    state: "visible",
    timeout: 30000,
  });

  // --- TEMPORARY DEBUG DUMP: remove once we've extended the scraper ---
  
  // --- END TEMPORARY DEBUG DUMP ---

  return inquiryPage.evaluate((selectors) => {
    // ---- generic helpers ----
    function textOf(el: Element | null): string {
      return el?.textContent?.trim() || "";
    }

    function valueOf(row: Element): string {
      const valueEl = row.querySelector(".Text");
      if (!valueEl) return "";
      const listItems = Array.from(valueEl.querySelectorAll(".ListItem"))
        .map((el) => textOf(el))
        .filter(Boolean);
      return listItems.length > 0 ? listItems.join(", ") : textOf(valueEl);
    }

    // Parses a .SectionContents element into network/coverageLevel/entries groups.
    // Works for Health Benefit Plan Coverage, Professional Office Visit, and
    // any other Waystar benefit section since they all share this DOM shape.
    function parseSectionContents(contents: Element | null) {
      const sections: Array<{ network?: string; coverageLevel?: string; entries: Array<Record<string, string>> }> = [];
      if (!contents) return sections;

      const typeKeywords = [
        "co-insurance", "coinsurance", "co-payment", "copayment", "copay",
        "deductible", "out of pocket", "limitations",
      ];

      const subSections = Array.from(contents.querySelectorAll(":scope > .SubSection"));
      for (const sub of subSections) {
        const network = textOf(sub.querySelector(":scope > .NetworkLine"));
        const groupings = Array.from(sub.querySelectorAll(":scope > .Grouping.clearfix"));
        for (const grouping of groupings) {
          const groupingLabel = grouping.querySelector(":scope > .GroupingLabel");
          const coverageLevel = textOf(groupingLabel?.querySelector(".CoverageLevel") ?? null) ||
            textOf(groupingLabel?.querySelector(".InsuranceType") ?? null) || undefined;
          const rightColumn = grouping.querySelector(":scope > .SubSection.RightColumn");
          if (!rightColumn) continue;

          // Split the Row children into chunks, each chunk separated by an hrDivider.
          const children = Array.from(rightColumn.children);
          const chunks: Element[][] = [];
          let current: Element[] = [];
          for (const child of children) {
            if (child.classList.contains("hrDivider")) {
              if (current.length > 0) chunks.push(current);
              current = [];
            } else if (child.classList.contains("Row")) {
              current.push(child);
            }
          }
          if (current.length > 0) chunks.push(current);

          const entries = chunks.map((rows) => {
            const entry: Record<string, string> = {};
            for (const row of rows) {
              const label = textOf(row.querySelector(".Label")).toLowerCase();
              const value = valueOf(row);
              if (!value) continue;
              if (!entry.type && typeKeywords.some((keyword) => label.includes(keyword))) {
                entry.type = textOf(row.querySelector(".Label"));
                entry.value = value;
              } else if (label.includes("place of service")) {
                entry.placeOfService = value;
              } else if (label.includes("payer note")) {
                entry.payerNote = value;
              } else if (label.includes("included provider special")) {
                entry.includedProviderSpecialties = value;
              }
            }
            return entry;
          }).filter((entry) => entry.type);

          if (entries.length > 0) {
            sections.push({ network: network || undefined, coverageLevel, entries });
          }
        }
      }
      return sections;
    }

    function findSectionByTitle(matchesTitle: (title: string) => boolean) {
      const headers = Array.from(document.querySelectorAll(".SectionHeader"));
      for (const header of headers) {
        const title = textOf(header.querySelector(".SectionTitle"));
        if (matchesTitle(title)) {
          const dataId = header.getAttribute("data-id");
          const contents = dataId ? document.querySelector(`.SectionContents[data-id="${dataId}"]`) : null;
          const status = textOf(header.querySelector(".SectionStatus"));
          return { title, status, contents };
        }
      }
      return null;
    }

    // Reads a labeled two-column block (e.g. "Subscriber Information").
    // Waystar echoes the bot-entered data first, then the payer-returned data
    // under the same heading further down the page — we want the LAST match.
    function readHalfColumn(headingText: string) {
      const halfColumns = Array.from(document.querySelectorAll(".HalfColumn"));
      const matches = halfColumns.filter((hc) =>
        textOf(hc.querySelector(":scope > h4")).toLowerCase() === headingText.toLowerCase(),
      );
      const target = matches[matches.length - 1];
      if (!target) return null;

      const fields: Record<string, string> = {};
      for (const row of Array.from(target.querySelectorAll(":scope > .Row.clearfix"))) {
        const label = textOf(row.querySelector(".Label"));
        const value = textOf(row.querySelector(".Text"));
        if (label) fields[label] = value;
      }
      const name = textOf(target.querySelector(":scope > .Text:not(.Address)")) || undefined;
      const address = textOf(target.querySelector(":scope > .Text.Address")) || undefined;
      return { fields, name, address };
    }

    function findRowValueByLabel(label: string): string | undefined {
      const rows = Array.from(document.querySelectorAll(".SectionContents .Row.clearfix"));
      for (const row of rows) {
        if (textOf(row.querySelector(".Label")) === label) {
          const value = valueOf(row);
          if (value) return value;
        }
      }
      return undefined;
    }

    // ---- overall status + fallback section list (unchanged) ----
    const overallStatus = textOf(document.querySelector(selectors.inquiry.activeCoverageDom));
    const sectionStatuses = Array.from(document.querySelectorAll(selectors.inquiry.sectionHeaders)).map((element) => ({
      title: textOf(element.querySelector(selectors.inquiry.sectionTitle)),
      status: textOf(element.querySelector(selectors.inquiry.sectionStatus)),
    })).filter((entry) => entry.title || entry.status);

    // ---- subscriber information ----
    const subscriberBlock = readHalfColumn("Subscriber Information");
    const subscriberInformation = subscriberBlock ? {
      patientName: subscriberBlock.name,
      address: subscriberBlock.address,
      memberId: subscriberBlock.fields["Member ID"],
      dateOfBirth: subscriberBlock.fields["Date of Birth"],
      sex: subscriberBlock.fields["Sex"],
    } : undefined;

    const coverageBlock = readHalfColumn("Subscriber Coverage Information");
    const subscriberCoverageInformation = coverageBlock ? {
      groupNumber: coverageBlock.fields["Group Number"],
      planDate: coverageBlock.fields["Plan Date"],
      premiumPaidToDateEnd: coverageBlock.fields["Premium Paid-to Date End"],
      insuranceType: coverageBlock.fields["Insurance Type"],
    } : undefined;

    const primaryCareProvider = findRowValueByLabel("Primary Care Provider");

    // ---- Health Benefit Plan Coverage (may be absent) ----
    const hbpc = findSectionByTitle((title) => title.toLowerCase().includes("health benefit plan coverage"));
    let healthBenefitPlanCoverage: {
      coverageDescription?: string;
      eligibilityBeginDate?: string;
      eligibilityEndDate?: string;
      planStatus?: string;
      planType?: string;
      benefitSections?: ReturnType<typeof parseSectionContents>;
    } | undefined;

    if (hbpc) {
      const hbpcSections = parseSectionContents(hbpc.contents);
      const planTypeEl = hbpc.contents?.querySelector(".InsuranceType") ?? null;
      healthBenefitPlanCoverage = {
        coverageDescription: findRowValueByLabel("Coverage Description"),
        eligibilityBeginDate: findRowValueByLabel("Eligibility Begin Date"),
        eligibilityEndDate: findRowValueByLabel("Eligibility End Date"),
        planStatus: hbpc.status,
        planType: textOf(planTypeEl) || undefined,
        benefitSections: hbpcSections.length > 0 ? hbpcSections : undefined,
      };
    }

    // ---- Professional (Physician) Visit - Office ----
    const officeSection = findSectionByTitle((title) => {
      const normalized = title.toLowerCase();
      return normalized.includes("professional") && normalized.includes("office");
    });
    const professionalOffice = officeSection ? parseSectionContents(officeSection.contents) : undefined;

    return {
      overallStatus,
      sectionStatuses,
      subscriberInformation,
      subscriberCoverageInformation,
      general: primaryCareProvider ? { primaryCareProvider } : undefined,
      healthBenefitPlanCoverage,
      professionalOffice,
    };
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
  const payerInput = page.locator(WAYSTAR_SELECTORS.inquiry.payerInput).first();
  if (await payerInput.isVisible().catch(() => false)) {
    const searchTerms = payerSearchTerms(payerName);
    for (const searchTerm of searchTerms) {
      await typePayerSearch(page, payerInput, searchTerm);
      const exactSuggestion = await findExactPayerSuggestion(page, payerName);
      if (exactSuggestion) {
        await exactSuggestion.scrollIntoViewIfNeeded().catch(() => {});
        await humanPause(page, 300, 650);
        await exactSuggestion.click();
        await humanPause(page, 450, 850);
      } else if (searchTerm === payerName) {
        await commitTypedPayerSelection(payerInput);
      }

      if (await isProviderReady(page, 5000)) {
        await waitForProviderReady(page);
        return;
      }
    }

    const currentValue = await payerInput.inputValue().catch(() => "");
    throw new Error(`Waystar payer selection did not activate the provider list after trying ${searchTerms.join(", ")}. Expected ${payerName}, found ${currentValue || "blank"}.`);
  }

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
    await waitForProviderReady(page);
    return;
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
      await suggestion.scrollIntoViewIfNeeded().catch(() => {});
      const label = (await suggestion.innerText().catch(() => "")).trim();
      if (isExactWaystarPayerMatch(label, payerName)) {
        return suggestion;
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function waitForProviderReady(page: Page, timeoutMs = 30000): Promise<void> {
  const provider = page.locator(WAYSTAR_SELECTORS.inquiry.provider).first();
  await provider.waitFor({ state: "visible", timeout: timeoutMs });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const disabled = await provider.isDisabled().catch(() => true);
    if (!disabled) return;
    await page.waitForTimeout(250);
  }

  throw new Error("Waystar provider field did not become active after selecting the payer.");
}

async function typePayerSearch(page: Page, payerInput: Locator, searchTerm: string): Promise<void> {
  await humanPause(page, 250, 600);
  await humanType(payerInput, searchTerm);

  const actualValue = await payerInput.inputValue().catch(() => "");
  if (actualValue.trim() !== searchTerm.trim()) {
    throw new Error(
      `Waystar payer search did not fill correctly. Expected ${searchTerm}, found ${actualValue || "blank"}.`,
    );
  }

  // Keep focus on the autocomplete. Dispatching change/blur here closes Waystar's
  // suggestion menu before its selection callback can populate the provider list.
  await page.waitForTimeout(500);
}

async function isProviderReady(page: Page, timeoutMs = 5000): Promise<boolean> {
  try {
    await waitForProviderReady(page, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function commitTypedPayerSelection(payerInput: Locator): Promise<void> {
  await payerInput.press("ArrowDown").catch(() => {});
  await payerInput.press("Enter").catch(() => {});
  await payerInput.page().waitForTimeout(400);
  await payerInput.press("Enter").catch(() => {});
  await payerInput.page().waitForTimeout(250);
  await payerInput.press("Tab").catch(() => {});
  await payerInput.page().waitForTimeout(250);
}

async function selectServiceType(page: Page, serviceTypeCode: string): Promise<void> {
  const serviceType = page.locator(WAYSTAR_SELECTORS.inquiry.serviceType).first();
  await serviceType.waitFor({ state: "visible", timeout: 30000 });
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
    await humanPause(page, 300, 650);
    await serviceType.selectOption(matchingOption.value);
  } else {
    await humanPause(page, 300, 650);
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

async function clickAddCodeIfVisible(page: Page): Promise<void> {
  const addCode = page.getByText("Add Code", { exact: true }).first();
  if (!(await addCode.isVisible().catch(() => false))) return;

  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    addCode.click(),
  ]).catch(async () => {
    await addCode.click().catch(() => {});
  });
  await page.waitForTimeout(300);
}

async function fillVerifiedText(page: Page, selector: string, value: string, label: string): Promise<void> {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 30000 });
  await humanPause(page, 250, 600);
  await humanType(input, value);
  await input.evaluate((element) => {
    const field = element as HTMLInputElement;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new Event("blur", { bubbles: true }));
  }).catch(() => {});
  await page.waitForTimeout(500);

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
    await humanPause(page, 300, 650);
    await provider.selectOption(credentials.providerId);
    return;
  }
  if (credentials.providerName) {
    await humanPause(page, 300, 650);
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

function payerSearchTerms(payerName: string): string[] {
  const normalized = normalizeText(payerName);
  if (!normalized.includes("bcbs") && !normalized.includes("blue cross")) return [payerName];

  const state = normalized.includes("texas") ? "Texas" : normalized.includes("florida") ? "Florida" : "";
  return Array.from(new Set(["BCBS", state ? `BCBS ${state}` : "", payerName].filter(Boolean)));
}

async function humanType(locator: Locator, value: string): Promise<void> {
  await locator.click();
  await locator.press("Control+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.pressSequentially(value, { delay: randomBetween(85, 140) });
}

async function humanPause(page: Page, minimumMs = 800, maximumMs = 1400): Promise<void> {
  await page.waitForTimeout(randomBetween(minimumMs, maximumMs));
}

function randomBetween(minimum: number, maximum: number): number {
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

function normalizeServiceTypeCode(value?: string): string | null {
  const text = (value || "").trim();
  if (!text) return null;
  const match = text.match(/^([A-Za-z0-9]{1,3})\b/);
  return match ? match[1].toUpperCase() : null;
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return trimmed;
  const [, month, day, year] = match;
  const normalizedYear = year.length === 2 ? `20${year}` : year;
  return `${String(Number(month)).padStart(2, "0")}/${String(Number(day)).padStart(2, "0")}/${normalizedYear}`;
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
  const match = value.match(/\(([a-z]{0,3}\d{3,})\)\s*$/i);
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
