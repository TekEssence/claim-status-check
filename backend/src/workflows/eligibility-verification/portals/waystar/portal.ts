import type { BrowserContext, Locator, Page } from "playwright-core";
import { WAYSTAR_SELECTORS } from "./selectors";
import type { WaystarCredentials, WaystarSecurityQuestion } from "./credentials";
import type { EligibilityInputRow } from "../../types";
import { normalizeWaystarDate } from "./dates";

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
  patientInformation?: {
    patientName?: string;
    address?: string;
    dateOfBirth?: string;
    sex?: string;
    relationshipToSubscriber?: string;
  };
  subscriberCoverageInformation?: {
    groupNumber?: string;
    planDate?: string;
    planNetworkName?: string;
    planSponsor?: string;
    planBeginDate?: string;
    planEndDate?: string;
    premiumPaidToDateEnd?: string;
    insuranceType?: string;
    otherInsurance?: string;
    otherInsuranceEffectiveDate?: string;
  };
  general?: { primaryCareProvider?: string; ipa?: string };
  healthBenefitPlanCoverage?: {
    coverageDescription?: string;
    eligibilityBeginDate?: string;
    eligibilityEndDate?: string;
    planStatus?: string;
    planType?: string;
    planSponsor?: string;
    benefitBeginDate?: string;
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

const authenticatedWaystarContexts = new WeakSet<BrowserContext>();
const cardSwipeAutoClosePages = new WeakSet<Page>();

export async function loginToWaystar(page: Page, credentials: WaystarCredentials): Promise<void> {
  try {
    await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (error) {
    if (!isWaystarAbortedNavigationError(error)) throw error;
    // The legacy ZirMed login can cancel its initial navigation while it
    // redirects to Waystar. Continue when the redirected login UI appears.
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  }
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
  authenticatedWaystarContexts.add(page.context());
}

export function isWaystarAbortedNavigationError(error: unknown): boolean {
  return error instanceof Error &&
    error.message.toLowerCase().includes("net::err_aborted");
}

export async function openEligibilityInquiry(page: Page): Promise<Page> {
  const existingInquiryPage = page.context().pages().find((candidate) =>
    candidate !== page && !candidate.isClosed() && candidate.url().includes("eligibility.zirmed.com/DDE"),
  );
  if (existingInquiryPage) {
    await enableCardSwipeAutoClose(existingInquiryPage);
    await existingInquiryPage.bringToFront().catch(() => {});
    await recoverStaleInquiryOverlay(existingInquiryPage);
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

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const popupPromise = page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null);
    await page.locator(WAYSTAR_SELECTORS.navigation.eligibility).first().click();
    const popup = await popupPromise;
    if (!popup) {
      lastError = new Error(`Waystar did not open the DDE inquiry window on attempt ${attempt}.`);
      continue;
    }
    try {
      await enableCardSwipeAutoClose(popup);
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      await popup.bringToFront().catch(() => {});
      await waitForInquiryControls(popup);
      return popup;
    } catch (error) {
      lastError = error;
      await popup.close().catch(() => {});
    }
  }
  throw new Error(`Waystar could not open a usable DDE inquiry window after two attempts. ${lastError instanceof Error ? lastError.message : "Unknown DDE window error."}`);
}

async function enableCardSwipeAutoClose(page: Page): Promise<void> {
  const installAutoClose = () => {
    const state = window as typeof window & { __waystarCardSwipeObserver?: MutationObserver };
    const dismiss = () => {
      const titles = Array.from(document.querySelectorAll(".ui-dialog-title"));
      for (const title of titles) {
        if (!/^card\s*swipe$/i.test(title.textContent?.trim() || "")) continue;
        const dialog = title.closest(".ui-dialog") ?? title.parentElement?.parentElement;
        const closeIcon = dialog?.querySelector<HTMLElement>(".ui-icon-closethick");
        const closeButton = closeIcon?.closest<HTMLElement>(
          ".ui-dialog-titlebar-close, button, a",
        ) ?? dialog?.querySelector<HTMLElement>(".ui-dialog-titlebar-close");
        closeButton?.click();
      }
    };

    if (!state.__waystarCardSwipeObserver) {
      state.__waystarCardSwipeObserver = new MutationObserver(dismiss);
      state.__waystarCardSwipeObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }
    dismiss();
  };

  if (!cardSwipeAutoClosePages.has(page)) {
    cardSwipeAutoClosePages.add(page);
    await page.addInitScript(installAutoClose);
  }

  // addInitScript applies to future documents. Install it immediately on the
  // already-open DDE document too, so dialogs created by AJAX are closed.
  await page.evaluate(installAutoClose).catch(() => {});
}
export async function submitWaystarInquiry(options: {
  page: Page;
  credentials: WaystarCredentials;
  payerName: string;
  serviceTypeCode?: string;
  patientLookupCode?: string;
  isCancelled?: () => boolean;
  onWaiting?: (elapsedSeconds: number) => Promise<void>;
  row: EligibilityInputRow;
}): Promise<WaystarInquiryPayload> {
  const { page, credentials, payerName, row } = options;
  const inquiryPage = await openEligibilityInquiry(page);
  await humanPause(inquiryPage, 650, 1200);
  const expectedServiceType = resolveWaystarServiceTypeCode(
    options.serviceTypeCode,
    row.serviceType,
    credentials.serviceTypeCode,
  );
  const expectedMemberId = normalizeWaystarMemberIdForPayer(payerName, row.memberId || row.subscriberId || "");
  const expectedLastName = row.patientLastName || "";
  const expectedFirstName = row.patientFirstName || "";
  const expectedDateOfBirth = normalizeWaystarDate(row.dateOfBirth || "");

  await selectInquiryPatientType(inquiryPage, row.relationshipToSubscriber);
  await humanPause(inquiryPage);
  await selectPayer(inquiryPage, payerName);
  await humanPause(inquiryPage);
  await selectProvider(inquiryPage, credentials);
  await humanPause(inquiryPage);
  const patientLookup = inquiryPage.locator(WAYSTAR_SELECTORS.inquiry.patientLookup).first();
  if (await patientLookup.isVisible().catch(() => false)) {
    const hasLookupOption = await patientLookup.locator('option[value="10"]').count() > 0;
    if (hasLookupOption) await patientLookup.selectOption("10");
  }
  await humanPause(inquiryPage);
  await selectServiceType(inquiryPage, expectedServiceType);
  if (options.patientLookupCode) {
    await selectPatientLookupOption(inquiryPage, options.patientLookupCode);
  }
  await waitForBlockingOverlaysToClear(inquiryPage, 30000);
  await dismissWaystarDatePicker(inquiryPage);
  await fillVerifiedText(inquiryPage, WAYSTAR_SELECTORS.inquiry.memberId, expectedMemberId, "Member ID");
  await fillVerifiedText(inquiryPage, WAYSTAR_SELECTORS.inquiry.lastName, expectedLastName, "Last Name");
  await fillVerifiedText(inquiryPage, WAYSTAR_SELECTORS.inquiry.firstName, expectedFirstName, "First Name");
  await fillVerifiedText(inquiryPage, WAYSTAR_SELECTORS.inquiry.dateOfBirth, expectedDateOfBirth, "Date of Birth", true);
  await dismissWaystarDatePicker(inquiryPage);
  await verifyInquiryFieldsBeforeSubmit(inquiryPage, {
    serviceTypeCode: expectedServiceType,
    patientLookupCode: options.patientLookupCode,
    memberId: expectedMemberId,
    lastName: expectedLastName,
    firstName: expectedFirstName,
    dateOfBirth: expectedDateOfBirth,
  });
  await humanPause(inquiryPage, 1800, 3000);

  await Promise.all([
    inquiryPage.waitForLoadState("networkidle").catch(() => {}),
    inquiryPage.locator(WAYSTAR_SELECTORS.inquiry.submit).click(),
  ]);

  await inquiryPage.waitForTimeout(500);
  const outcome = await waitForWaystarEligibilityOutcome(
    inquiryPage,
    180000,
    options.isCancelled,
    options.onWaiting,
  );
  if (outcome === "cancelled") {
    throw new Error("Waystar eligibility cancellation requested.");
  }
  if (outcome === "timeout") {
    await inquiryPage.getByRole("button", { name: "New Inquiry", exact: true }).click()
      .catch(() => inquiryPage.getByText("New Inquiry", { exact: true }).click());
    await waitForInquiryControls(inquiryPage);
    throw new Error("Waystar eligibility inquiry timed out at the payer.");
  }
  if (outcome === "login") {
    throw new Error("Waystar session returned to the login page while waiting for the payer response.");
  }
  if (outcome === "stalled") {
    throw new Error("Waystar eligibility inquiry timed out while waiting for the payer response.");
  }  // Waystar can leave its loading overlay mounted after the payer result is
  // already visible. Do not turn a visible ACTIVE/INACTIVE response into an
  // automation error just because that stale overlay did not disappear.
  await waitForBlockingOverlaysToClear(inquiryPage, 10000).catch(() => {});
  // The status bar can appear before all payer-returned sections finish rendering.
  // Keep the result visible before taking the DOM snapshot.
  await inquiryPage.waitForTimeout(2000);

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
        "co-insurance", "co insurance", "coinsurance", "co-payment", "co payment",
        "copayment", "copay", "deductible", "out of pocket", "out-of-pocket",
        "limitations",
      ];

      const subSections = Array.from(contents.querySelectorAll(".SubSection"));
      const containers = subSections.length > 0 ? subSections : [contents];
      for (const sub of containers) {
        const subNetwork = textOf(sub.querySelector(".NetworkLine"));
        const foundGroupings = Array.from(sub.querySelectorAll(".Grouping"));
        const groupings = foundGroupings.length > 0 ? foundGroupings : [sub];
        for (const grouping of groupings) {
          const coverageLevel = textOf(grouping.querySelector(".CoverageLevel")) ||
            textOf(grouping.querySelector(".InsuranceType")) || undefined;
          const network = textOf(grouping.querySelector(".NetworkLine")) || subNetwork || undefined;
          const entries: Array<Record<string, string>> = [];
          let currentEntry: Record<string, string> | null = null;

          for (const row of Array.from(grouping.querySelectorAll(".Row"))) {
            const rawLabel = textOf(row.querySelector(".Label"));
            const label = rawLabel.toLowerCase().replace(/\s+/g, " ");
            const value = valueOf(row);
            if (!value) continue;

            if (typeKeywords.some((keyword) => label.includes(keyword))) {
              currentEntry = { type: rawLabel, value };
              entries.push(currentEntry);
            } else if (currentEntry && label.includes("place of service")) {
              currentEntry.placeOfService = value;
            } else if (currentEntry && label.includes("payer note")) {
              currentEntry.payerNote = value;
            } else if (currentEntry && label.includes("included provider special")) {
              currentEntry.includedProviderSpecialties = value;
            }
          }

          if (entries.length > 0) sections.push({ network, coverageLevel, entries });
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
          const contentsById = dataId
            ? Array.from(document.querySelectorAll(".SectionContents"))
              .find((candidate) => candidate.getAttribute("data-id") === dataId) ?? null
            : null;
          const nextElement = header.nextElementSibling?.classList.contains("SectionContents")
            ? header.nextElementSibling
            : null;
          const contents = contentsById || nextElement ||
            header.parentElement?.querySelector(".SectionContents") || null;
          const status = textOf(header.querySelector(".SectionStatus"));
          return { title, status, contents };
        }
      }
      return null;
    }

    // Reads a labeled two-column block (e.g. "Subscriber Information").
    // Waystar echoes the bot-entered data first, then the payer-returned data
    // under the same heading further down the page â€” we want the LAST match.
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

    function normalizeFieldLabel(value: string): string {
      return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function findRowValueByLabel(label: string): string | undefined {
      const wantedLabel = normalizeFieldLabel(label);
      const rows = Array.from(document.querySelectorAll(".SectionContents .Row.clearfix, .HalfColumn .Row.clearfix"));
      for (const row of rows) {
        if (normalizeFieldLabel(textOf(row.querySelector(".Label"))) === wantedLabel) {
          const value = valueOf(row);
          if (value) return value;
        }
      }
      return undefined;
    }

    // ---- overall status + fallback section list (unchanged) ----
    const statusElementText = textOf(document.querySelector(selectors.inquiry.activeCoverageDom));
    const visibleCoverageBanner = document.body?.innerText.match(/\b(?:INACTIVE|ACTIVE)\s+COVERAGE\b/i)?.[0];
    const overallStatus = visibleCoverageBanner || statusElementText;
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

    const patientBlock = readHalfColumn("Patient Information");
    const patientInformation = patientBlock ? {
      patientName: patientBlock.name,
      address: patientBlock.address,
      dateOfBirth: patientBlock.fields["Date of Birth"],
      sex: patientBlock.fields["Sex"],
      relationshipToSubscriber: patientBlock.fields["Relationship to Subscriber"],
    } : undefined;

    const coverageBlock = readHalfColumn("Subscriber Coverage Information") ??
      readHalfColumn("Patient Coverage Information");
    const otherInsuranceBlock = readHalfColumn("Other Insurance Information") ?? readHalfColumn("Other Insurance");
    const subscriberCoverageInformation = coverageBlock ? {
      groupNumber: coverageBlock.fields["Group Number"],
      planDate: coverageBlock.fields["Plan Date"] || findRowValueByLabel("Plan Date"),
      planNetworkName: coverageBlock.fields["Plan Network Name"] || findRowValueByLabel("Plan Network Name"),
      planSponsor: coverageBlock.fields["Plan Sponsor"] || findRowValueByLabel("Plan Sponsor"),
      planBeginDate: coverageBlock.fields["Plan Begin Date"] || findRowValueByLabel("Plan Begin Date") || findRowValueByLabel("Benefit Begin Date"),
      planEndDate: coverageBlock.fields["Plan End Date"] || findRowValueByLabel("Plan End Date"),
      premiumPaidToDateEnd: coverageBlock.fields["Premium Paid-to Date End"],
      insuranceType: coverageBlock.fields["Insurance Type"],
      otherInsurance: otherInsuranceBlock?.fields["Payer Name"] ?? otherInsuranceBlock?.fields["Insurance Name"] ?? coverageBlock.fields["Other Insurance Payer Name"] ?? coverageBlock.fields["Other Insurance"] ?? coverageBlock.fields["Other Ins"] ?? findRowValueByLabel("Other Insurance Payer Name") ?? findRowValueByLabel("Other Payer Name") ?? findRowValueByLabel("Other Insurance") ?? findRowValueByLabel("Other Ins"),
      otherInsuranceEffectiveDate: otherInsuranceBlock?.fields["Effective Date"] ?? otherInsuranceBlock?.fields["Eligibility Begin Date"] ?? coverageBlock.fields["Other Insurance Effective Date"] ?? coverageBlock.fields["Other Insurance Eff Date"] ?? coverageBlock.fields["Other Ins Eff Date"] ?? findRowValueByLabel("Other Insurance Effective Date") ?? findRowValueByLabel("Other Insurance Eff Date") ?? findRowValueByLabel("Other Ins Eff Date"),
    } : undefined;

    const primaryCareProvider = findRowValueByLabel("Primary Care Provider");
    const ipa = findRowValueByLabel("Independent Physicians Association (IPA)") || findRowValueByLabel("IPA");

    // ---- Health Benefit Plan Coverage (may be absent) ----
    const hbpc = findSectionByTitle((title) => title.toLowerCase().includes("health benefit plan coverage"));
    let healthBenefitPlanCoverage: {
      coverageDescription?: string;
      eligibilityBeginDate?: string;
      eligibilityEndDate?: string;
      planStatus?: string;
      planType?: string;
      planSponsor?: string;
      benefitBeginDate?: string;
      benefitSections?: ReturnType<typeof parseSectionContents>;
    } | undefined;

    if (hbpc) {
      const hbpcSections = selectors.minimalEligibilityOnly ? [] : parseSectionContents(hbpc.contents);
      const planTypeEl = hbpc.contents?.querySelector(".InsuranceType") ?? null;
      healthBenefitPlanCoverage = {
        coverageDescription: findRowValueByLabel("Coverage Description"),
        eligibilityBeginDate: findRowValueByLabel("Eligibility Begin Date"),
        eligibilityEndDate: findRowValueByLabel("Eligibility End Date"),
        planStatus: hbpc.status,
        planType: textOf(planTypeEl) || undefined,
        planSponsor: findRowValueByLabel("Plan Sponsor"),
        benefitBeginDate: findRowValueByLabel("Benefit Begin Date") || findRowValueByLabel("Plan Begin Date"),
        benefitSections: hbpcSections.length > 0 ? hbpcSections : undefined,
      };
    }

    // ---- Professional (Physician) Visit - Office ----
    const officeSection = findSectionByTitle((title) => {
      const normalized = title.toLowerCase();
      return normalized.includes("professional") && normalized.includes("office");
    });
    const professionalOffice = selectors.minimalEligibilityOnly ? undefined : officeSection ? parseSectionContents(officeSection.contents) : undefined;

    return {
      overallStatus,
      sectionStatuses,
      subscriberInformation,
      patientInformation,
      subscriberCoverageInformation,
      general: primaryCareProvider || ipa ? { primaryCareProvider, ipa } : undefined,
      healthBenefitPlanCoverage,
      professionalOffice,
    };
  }, {
    minimalEligibilityOnly: isExactWaystarPayerMatch(payerName, "BayCare Plus Medicare Advantage (81079)") || isExactWaystarPayerMatch(payerName, "Aetna (Medicare Advantage) (60054MA)") || isExactWaystarPayerMatch(payerName, "United Healthcare(87726)") || isExactWaystarPayerMatch(payerName, "AARP Medicare Advantage Choice Plan (87726)"),
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

export function normalizeWaystarMemberIdForPayer(payerName: string, memberId: string): string {
  const value = memberId.trim();
  const isBayCare = isExactWaystarPayerMatch(
    payerName,
    "BayCare Plus Medicare Advantage (81079)",
  );
  const isUnitedHealthcare = isExactWaystarPayerMatch(payerName, "United Healthcare(87726)");
  const isAarpMedicareComplete = isExactWaystarPayerMatch(payerName, "AARP Medicare Advantage Choice Plan (87726)");
  return (isBayCare || isUnitedHealthcare || isAarpMedicareComplete) && /^\d+$/.test(value) ? `000${value}` : value;
}
export function isExactWaystarPayerMatch(candidate: string, target: string): boolean {
  const normalizedCandidate = normalizePayerSuggestion(candidate);
  const normalizedTarget = normalizePayerSuggestion(target);
  if (normalizedCandidate === normalizedTarget) return true;
const candidateIsAarp = normalizedCandidate.includes("aarp");
  const targetIsAarp = normalizedTarget.includes("aarp");
  if (candidateIsAarp !== targetIsAarp) return false;
if (
    normalizedTarget.includes("united healthcare") &&
    normalizedTarget.includes("all states") &&
    normalizedCandidate.includes("united healthcare") &&
    normalizedCandidate.includes("all states")
  ) return true;

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
  patientLookupValue: string;
  patientLookupLabel: string;
  memberId: string;
  lastName: string;
  firstName: string;
  dateOfBirth: string;
};

export function resolveWaystarServiceTypeCode(
  payerServiceTypeCode: string | undefined,
  rowServiceTypeCode: string | undefined,
  credentialServiceTypeCode: string,
): string {
  return normalizeServiceTypeCode(payerServiceTypeCode) ||
    normalizeServiceTypeCode(rowServiceTypeCode) ||
    credentialServiceTypeCode;
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

  await payerInput.or(payerSelect).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {
    throw new Error("Waystar DDE opened, but neither payer search control became visible within 30 seconds.");
  });
}

async function selectInquiryPatientType(page: Page, relationship?: string): Promise<void> {
  const normalizedRelationship = normalizeText(relationship || "");
  const isSubscriber = !normalizedRelationship || ["self", "subscriber", "18"].includes(normalizedRelationship);
  if (isSubscriber) {
    await page.locator(WAYSTAR_SELECTORS.inquiry.subscriberRadio).first().check();
    return;
  }

  const patientRadio = page.locator(WAYSTAR_SELECTORS.inquiry.patientRadio).first();
  await patientRadio.waitFor({ state: "visible", timeout: 30000 });
  await patientRadio.check();
  await humanPause(page);

  const relationshipSelect = page.locator(WAYSTAR_SELECTORS.inquiry.relationship).first();
  await relationshipSelect.waitFor({ state: "visible", timeout: 30000 });
  await waitForEnabled(relationshipSelect, "Waystar relationship to subscriber");
  const options = await relationshipSelect.locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: (node as HTMLOptionElement).value,
      label: node.textContent?.trim() || "",
    })),
  );
  const target = normalizeRelationship(relationship || "");
  const match = options.find((option) => {
    const label = normalizeRelationship(option.label);
    const value = normalizeRelationship(option.value);
    return label === target || value === target || label.includes(target) || target.includes(label);
  });
  if (!match?.value) {
    throw new Error(
      `Waystar relationship "${relationship}" was not available. Options: ${options.map((option) => option.label).filter(Boolean).join(", ") || "none"}.`,
    );
  }
  await relationshipSelect.selectOption(match.value);
  const selectedLabel = await relationshipSelect.locator("option:checked").textContent().catch(() => "");
  if (normalizeRelationship(selectedLabel || "") !== normalizeRelationship(match.label)) {
    throw new Error(`Waystar relationship to subscriber did not remain selected. Expected ${match.label}.`);
  }
}

function normalizeRelationship(value: string): string {
  const normalized = normalizeText(value);
  if (["wife", "husband"].includes(normalized)) return "spouse";
  if (["son", "daughter"].includes(normalized)) return "child";
  return normalized;
}
async function selectPayer(page: Page, payerName: string): Promise<void> {
  const payerInput = page.locator(WAYSTAR_SELECTORS.inquiry.payerInput).first();
  if (await payerInput.isVisible().catch(() => false)) {
    const retainedPayer = await payerInput.inputValue().catch(() => "");
    if (isExactWaystarPayerMatch(retainedPayer, payerName)) {
      if (await isProviderReady(page, 2000)) return;
      await commitTypedPayerSelection(payerInput);
      if (await isProviderReady(page, 5000)) {
        await waitForProviderReady(page);
        return;
      }
    }

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

  // Keep focus while Waystar opens the autocomplete suggestions.
  await page.waitForTimeout(50);
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
  await payerInput.page().waitForTimeout(50);
  await payerInput.press("Enter").catch(() => {});
  await payerInput.page().waitForTimeout(50);
  await payerInput.press("Tab").catch(() => {});
  await payerInput.page().waitForTimeout(50);
}

export function findWaystarPatientLookupOption(
  options: Array<{ value: string; label: string }>,
  lookupCode: string,
): { value: string; label: string } | null {
  const normalizedExpectedLabel = "sbr id lname fname dob";
  return options.find((option) => option.value === lookupCode) ??
    options.find((option) => normalizeText(option.label) === normalizedExpectedLabel) ??
    null;
}

async function selectPatientLookupOption(page: Page, lookupCode: string): Promise<void> {
  const lookup = page.locator(WAYSTAR_SELECTORS.inquiry.patientLookup).first();
  await lookup.waitFor({ state: "visible", timeout: 30000 });
  await waitForEnabled(lookup, "Waystar Look Up By");
  const options = await lookup.locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: (node as HTMLOptionElement).value,
      label: (node.textContent || "").trim(),
    })),
  );
  const expected = findWaystarPatientLookupOption(options, lookupCode);
  if (!expected) {
    throw new Error(`Waystar Look Up By option Sbr ID, LName, FName, DOB (${lookupCode}) was not available.`);
  }
  await lookup.selectOption(expected.value);
  const selected = await lookup.locator("option:checked").evaluate((node) => ({
    value: (node as HTMLOptionElement).value,
    label: (node.textContent || "").trim(),
  }));
  if (selected.value !== expected.value || normalizeText(selected.label) !== normalizeText(expected.label)) {
    throw new Error(`Waystar Look Up By selection did not stick. Expected ${expected.label}, found ${selected.label || selected.value || "blank"}.`);
  }
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

async function dismissWaystarDatePicker(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  const datePicker = page.locator("#ui-datepicker-div:visible").first();
  if (await datePicker.isVisible().catch(() => false)) {
    await datePicker.evaluate((element) => {
      (element as HTMLElement).style.display = "none";
    }).catch(() => {});
  }
}
async function fillVerifiedText(page: Page, selector: string, value: string, label: string, compareAsDate = false): Promise<void> {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 30000 }).catch(() => {
    throw new Error(`Waystar inquiry field ${label} was not visible after 30 seconds.`);
  });
  await waitForEnabled(input, `Waystar ${label}`);
  await humanType(input, value);
  await commitInputValue(input);
  await page.waitForTimeout(50);

  let actualValue = await input.inputValue().catch(() => "");
  let matches = compareAsDate ? waystarDatesMatch(actualValue, value) : actualValue.trim() === value.trim();
  if (!matches) {
    await input.click();
    await input.press("Control+A").catch(() => {});
    await input.press("Backspace").catch(() => {});
    await input.pressSequentially(value, { delay: randomBetween(25, 40) });
    await commitInputValue(input);
    await page.waitForTimeout(150);
    actualValue = await input.inputValue().catch(() => "");
    matches = compareAsDate ? waystarDatesMatch(actualValue, value) : actualValue.trim() === value.trim();
  }
  if (!matches) {
    await input.evaluate((element, expectedValue) => {
      const field = element as HTMLInputElement;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(field, expectedValue);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
    await page.waitForTimeout(250);
    actualValue = await input.inputValue().catch(() => "");
    matches = compareAsDate ? waystarDatesMatch(actualValue, value) : actualValue.trim() === value.trim();
  }
  if (!matches) {
    throw new Error(`Waystar ${label} did not fill correctly. Expected ${value}, found ${actualValue || "blank"}.`);
  }
}

async function commitInputValue(input: Locator): Promise<void> {
  await input.evaluate((element) => {
    const field = element as HTMLInputElement;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new Event("blur", { bubbles: true }));
  }).catch(() => {});
}
async function verifyInquiryFieldsBeforeSubmit(
  page: Page,
  expected: {
    serviceTypeCode: string;
    patientLookupCode?: string;
    memberId: string;
    lastName: string;
    firstName: string;
    dateOfBirth: string;
  },
  retryCount = 0,
): Promise<void> {
  const snapshot = await readInquirySnapshot(page);
  const missing: string[] = [];

  if (!findWaystarServiceTypeOption([
    { value: snapshot.serviceTypeValue, label: snapshot.serviceTypeLabel },
  ], expected.serviceTypeCode)) {
    missing.push(`serviceType=${snapshot.serviceTypeLabel || snapshot.serviceTypeValue || "blank"}`);
  }
  if (expected.patientLookupCode && !findWaystarPatientLookupOption([
    { value: snapshot.patientLookupValue, label: snapshot.patientLookupLabel },
  ], expected.patientLookupCode)) {
    missing.push(`patientLookup=${snapshot.patientLookupLabel || snapshot.patientLookupValue || "blank"}`);
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
  if (!waystarDatesMatch(snapshot.dateOfBirth, expected.dateOfBirth)) {
    missing.push(`dateOfBirth=${snapshot.dateOfBirth || "blank"}`);
  }

  if (missing.length > 0 && retryCount === 0) {
    await dismissWaystarDatePicker(page);
    await selectServiceType(page, expected.serviceTypeCode);
    if (expected.patientLookupCode) {
      await selectPatientLookupOption(page, expected.patientLookupCode);
    }
    await fillVerifiedText(page, WAYSTAR_SELECTORS.inquiry.memberId, expected.memberId, "Member ID");
    await fillVerifiedText(page, WAYSTAR_SELECTORS.inquiry.lastName, expected.lastName, "Last Name");
    await fillVerifiedText(page, WAYSTAR_SELECTORS.inquiry.firstName, expected.firstName, "First Name");
    await fillVerifiedText(page, WAYSTAR_SELECTORS.inquiry.dateOfBirth, expected.dateOfBirth, "Date of Birth", true);
    await dismissWaystarDatePicker(page);
    return verifyInquiryFieldsBeforeSubmit(page, expected, 1);
  }
  if (missing.length > 0) {
    throw new Error(`Waystar inquiry fields were not present on the page before submit after one refill. ${missing.join(", ")}.`);
  }
}

function waystarDatesMatch(actual: string, expected: string): boolean {
  try {
    return normalizeWaystarDate(actual) === normalizeWaystarDate(expected);
  } catch {
    return false;
  }
}

async function readInquirySnapshot(page: Page): Promise<WaystarInquirySnapshot> {
  const serviceType = page.locator(WAYSTAR_SELECTORS.inquiry.serviceType).first();
  const selectedService = await serviceType.locator("option:checked").evaluate((node) => ({
    value: (node as HTMLOptionElement | null)?.value || "",
    label: (node as HTMLOptionElement | null)?.textContent?.trim() || "",
  })).catch(() => ({ value: "", label: "" }));

  const patientLookup = page.locator(WAYSTAR_SELECTORS.inquiry.patientLookup).first();
  const selectedPatientLookup = await patientLookup.locator("option:checked").evaluate((node) => ({
    value: (node as HTMLOptionElement | null)?.value || "",
    label: (node as HTMLOptionElement | null)?.textContent?.trim() || "",
  })).catch(() => ({ value: "", label: "" }));

  return {
    serviceTypeValue: selectedService.value,
    serviceTypeLabel: selectedService.label,
    patientLookupValue: selectedPatientLookup.value,
    patientLookupLabel: selectedPatientLookup.label,
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

export function payerSearchTerms(payerName: string): string[] {
  const normalized = normalizeText(payerName);
  if (extractWaystarPayerId(payerName) === "61101" && normalized.includes("humana")) {
    return ["humana"];
  }
  if (normalized.includes("aarp medicare advantage choice plan")) {
    return ["AARP Medicare Advantage Choice Plan", payerName];
  }
  if (extractWaystarPayerId(payerName) === "87726") {
    return ["UHC", payerName];
  }
if (normalized.includes("united healthcare") && normalized.includes("all states")) {
    return ["UHC", payerName];
  }
  if (!normalized.includes("bcbs") && !normalized.includes("blue cross")) return [payerName];

  const state = normalized.includes("texas") ? "Texas" : normalized.includes("florida") ? "Florida" : "";
  return Array.from(new Set(["BCBS", state ? `BCBS ${state}` : "", payerName].filter(Boolean)));
}

async function waitForWaystarEligibilityOutcome(
  page: Page,
  timeoutMs: number,
  isCancelled?: () => boolean,
  onWaiting?: (elapsedSeconds: number) => Promise<void>,
): Promise<"response" | "timeout" | "login" | "stalled" | "cancelled"> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let nextHeartbeatAt = startedAt + 15000;
  while (Date.now() < deadline) {
    if (isCancelled?.()) return "cancelled";
    if (page.isClosed()) return "stalled";
    if (onWaiting && Date.now() >= nextHeartbeatAt) {
      await onWaiting(Math.round((Date.now() - startedAt) / 1000));
      nextHeartbeatAt = Date.now() + 15000;
    }
    const state = await page.evaluate(({ overallStatusSelector, sectionStatusSelector }) => {
      const bodyText = document.body?.innerText || "";
      if (/Eligibility Inquiry Timed Out/i.test(bodyText)) return "timeout";
      if (/login\.zirmed\.com/i.test(location.href) || document.querySelector("#loginName")) return "login";

      const overallStatus = document.querySelector(overallStatusSelector)?.textContent || "";
      const sectionStatuses = Array.from(document.querySelectorAll(sectionStatusSelector))
        .map((element) => element.textContent || "")
        .join(" ");
      const returnedStatus = `${overallStatus} ${sectionStatuses}`;
      const hasCoverageOutcome = /\b(?:inactive|active)\b/i.test(returnedStatus) ||
        /\b(?:failed at payer|subscriber not found)\b/i.test(returnedStatus) ||
        /\b(?:inactive|active)\s+coverage\b/i.test(bodyText);
      const hasRenderedResult = Boolean(document.querySelector("#btnUpdateInquiry")) &&
        (Boolean(document.querySelector(".SectionHeader")) || /Coverage Details/i.test(bodyText));
      return hasCoverageOutcome || hasRenderedResult ? "response" : "waiting";
    }, {
      overallStatusSelector: sanitizeDomSelector(WAYSTAR_SELECTORS.inquiry.activeCoverage),
      sectionStatusSelector: sanitizeDomSelector(WAYSTAR_SELECTORS.inquiry.sectionStatus),
    }).catch(() => "waiting") as "response" | "timeout" | "login" | "waiting";

    if (state !== "waiting") return state;
    await page.waitForTimeout(1000);
  }
  return "stalled";
}
async function waitForBlockingOverlaysToClear(page: Page, timeoutMs: number): Promise<void> {
  const overlays = page.locator(WAYSTAR_SELECTORS.inquiry.blockingOverlay);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await overlays.count().catch(() => 0) === 0) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`Waystar remained on its loading screen for ${Math.round(timeoutMs / 1000)} seconds.`);
}
async function recoverStaleInquiryOverlay(page: Page): Promise<void> {
  const overlays = page.locator(WAYSTAR_SELECTORS.inquiry.blockingOverlay);
  if (await overlays.count().catch(() => 0) === 0) return;

  await overlays.first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  if (await overlays.count().catch(() => 0) === 0) return;

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForInquiryControls(page);
}
async function humanType(locator: Locator, value: string): Promise<void> {
  await locator.click();
  await locator.press("Control+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  const delay = authenticatedWaystarContexts.has(locator.page().context())
    ? randomBetween(8, 18)
    : randomBetween(85, 140);
  await locator.pressSequentially(value, { delay });
}
async function humanPause(page: Page, minimumMs = 800, maximumMs = 1400): Promise<void> {
  if (authenticatedWaystarContexts.has(page.context())) return;
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





