import path from "node:path";
import type { FrameLocator, Locator, Page } from "playwright-core";
import { buildPaymentPostingScreenshotFilename } from "../../base";
import type {
  DisplayedPaymentPostingLineItem,
  PaymentPostingInputRow,
} from "../../types";
import type { AdvancedMdPaymentPostingCredentials } from "./credentials";
import {
  findLineItemMatch,
  normalizeAdvancedMdDate,
  normalizeCurrencyCents,
} from "./line-items";

export type AdvancedMdSelectorConfig = {
  login: {
    url: string;
    frame: string;
    usernameInput: string;
    passwordInput: string;
    officeKeyInput: string;
    pmRadio: string;
    signInButton: string;
  };
  notifications: {
    snoozeAllButton: string;
  };
  navigation: {
    billingMenu: string;
    quickPayMenuItem: string;
    paymentEntryTab: string;
  };
  paymentEntry: {
    eobSection: string;
    checkNumberInput: string;
    carrierInput: string;
    carrierDropdownOptions: string;
    checkAmountInput: string;
    depositDateInput: string;
    patientInput: string;
    patientDropdownOptions: string;
    visitClaimInput: string;
    visitClaimDropdownOptions: string;
    paymentAmountInput: string;
    remainingAmountValue: string;
    lineItemTable: string;
  };
  lineItems: {
    row: string;
    dateCell: string;
    codeCell: string;
    chargeCell: string;
    insurancePortionCell: string;
    patientPortionCell: string;
    insuranceAllowedInput: string;
    insuranceNotAllowedCell: string;
    paymentInput: string;
    insuranceBalanceCell: string;
    patientBalanceCell: string;
    writeOffCodeCell: string;
    writeOffCell: string;
    statusDropdown: string;
    paymentReasonButton: string;
    riskCodeCell: string;
    riskAmountCell: string;
    providerCell: string;
  };
  paymentReasons: {
    dialog: string;
    paymentReasonsTab: string;
    remarkCodesTab: string;
    paymentReasonSearchInput: string;
    remarkCodeSearchInput: string;
    resultRows: string;
    saveButton: string;
  };
  screenshots: {
    completedStateTarget: string;
  };
};

export const ADVANCEDMD_PAYMENT_POSTING_SELECTORS: AdvancedMdSelectorConfig = {
  login: {
    url: "https://login.advancedmd.com/",
    frame: "iframe#frame-login",
    usernameInput: "input[name=\"loginName\"], input[formcontrolname=\"loginName\"], input[aria-label=\"Login name\"], input[autocomplete=\"username\"]",
    passwordInput: "input[type=\"password\"], input[name=\"password\"], input[formcontrolname=\"password\"], input[autocomplete=\"current-password\"]",
    officeKeyInput: "input[name=\"officeKey\"], input[formcontrolname=\"officeKey\"], input[aria-label=\"Office key\"]",
    pmRadio: "input[value=\"PM\"], input[type=\"radio\"]",
    signInButton: "button:has-text(\"Log in\"), button:has-text(\"Login\"), input[type=\"submit\"], input[type=\"button\"]",
  },
  notifications: {
    snoozeAllButton: ".notify-snooze-all button.btn.btn-primary",
  },
  navigation: {
    billingMenu: "a.dropdown-toggle:has-text(\"Billing\")",
    quickPayMenuItem: "li[ng-repeat=\"menuItem in subnav.menuItems track by $index\"] > a[ng-bind=\"menuItem.title\"]:has-text(\"Quick Pay\")",
    paymentEntryTab: "[title=\"Payment Entry\"], .tab-title:has-text(\"Payment Entry\"), .tab:has-text(\"Payment Entry\")",
  },
  paymentEntry: {
    eobSection: ".eob, .eob amds-eob-check, .eob .eob-container, amds-eob-check",
    checkNumberInput: ".eob [data-pendo-id=\"eob-checknumber-single-search-input-20250104\"], .eob amds-single-eob-search, .eob amds-eob-check amds-single-eob-search, [data-pendo-id=\"eob-checknumber-single-search-input-20250104\"], amds-eob-check amds-single-eob-search, amds-single-eob-search",
    carrierInput: ".eob [data-pendo-id=\"eob-carrier-input-search-20240229\"], .eob amds-eob-carrier-lookup, [data-pendo-id=\"eob-carrier-input-search-20240229\"], amds-eob-carrier-lookup",
    carrierDropdownOptions: ".mat-autocomplete-panel [role=\"option\"], [role=\"listbox\"] [role=\"option\"]",
    checkAmountInput: ".eob input[formcontrolname=\"eobCheckAmount\"], .eob [formcontrolname=\"eobCheckAmount\"]",
    depositDateInput: ".eob [data-pendo-id=\"eob-check-deposit-date-20240229\"], .eob input[formcontrolname=\"eobDepositDate\"], [data-pendo-id=\"eob-check-deposit-date-20240229\"]",
    patientInput: "[data-pendo-id=\"payment-entry-patient-search-input-20240229\"], amds-patient-lookup-control[controlname=\"patientLookup\"], amds-patient-lookup-control",
    patientDropdownOptions: ".mat-autocomplete-panel [role=\"option\"], [role=\"listbox\"] [role=\"option\"], .cdk-overlay-pane [role=\"option\"]",
    visitClaimInput: "[data-pendo-id=\"payment-entry-visit-input-20240229\"], amds-visit-field",
    visitClaimDropdownOptions: ".mat-autocomplete-panel [role=\"option\"], [role=\"listbox\"] [role=\"option\"], .cdk-overlay-pane [role=\"option\"]",
    paymentAmountInput: ".pf-payment-data-section input[formcontrolname=\"amount\"], .pf-payment-data-section input[formcontrolname=\"paymentAmount\"]",
    remainingAmountValue: "input[formcontrolname=\"amountRemaining\"], input[formcontrolname*=\"remaining\" i], .remaining input, .remaining",
    lineItemTable: ".pf-charges-grid, amds-charges-grid, .pf-charges-grid table[mat-table], amds-charges-grid table[mat-table]",
  },
  lineItems: {
    row: ".pf-charges-grid tr[mat-row], .pf-charges-grid .mat-row, amds-charges-grid tr[mat-row], amds-charges-grid .mat-row",
    dateCell: ".mat-column-dateOfService, .cdk-column-dateOfService, .mat-column-date, .cdk-column-date",
    codeCell: ".mat-column-chargeCode, .cdk-column-chargeCode, .mat-column-code, .cdk-column-code",
    chargeCell: ".mat-column-chargeAmount, .cdk-column-chargeAmount, .mat-column-charge, .cdk-column-charge",
    insurancePortionCell: ".mat-column-insurancePortion, .cdk-column-insurancePortion, .mat-column-insPortion, .cdk-column-insPortion",
    patientPortionCell: ".mat-column-patientPortion, .cdk-column-patientPortion",
    insuranceAllowedInput: ".mat-column-allowedAmount input, .cdk-column-allowedAmount input, .mat-column-insuranceAllowed input, .cdk-column-insuranceAllowed input",
    insuranceNotAllowedCell: ".mat-column-notAllowedAmount, .cdk-column-notAllowedAmount, .mat-column-insuranceNotAllowed, .cdk-column-insuranceNotAllowed",
    paymentInput: ".mat-column-amount input, .cdk-column-amount input, .mat-column-payment input, .cdk-column-payment input",
    insuranceBalanceCell: ".mat-column-insuranceBalance, .cdk-column-insuranceBalance",
    patientBalanceCell: ".mat-column-patientBalance, .cdk-column-patientBalance",
    writeOffCodeCell: ".mat-column-writeOffCode, .cdk-column-writeOffCode",
    writeOffCell: ".mat-column-writeOffAmount, .cdk-column-writeOffAmount, .mat-column-writeOff, .cdk-column-writeOff",
    statusDropdown: ".mat-column-paymentStatus input, .cdk-column-paymentStatus input, .mat-column-status input, .cdk-column-status input",
    paymentReasonButton: ".mat-column-paymentReasons .payment-reasons-code-editable, .cdk-column-paymentReasons .payment-reasons-code-editable, .mat-column-paymentReasons, .cdk-column-paymentReasons, .mat-column-carcRarc button, .cdk-column-carcRarc button",
    riskCodeCell: ".mat-column-riskCode, .cdk-column-riskCode",
    riskAmountCell: ".mat-column-riskAmount, .cdk-column-riskAmount",
    providerCell: ".mat-column-provider, .cdk-column-provider",
  },
  paymentReasons: {
    dialog: "amds-rarc, .rarc-body, .mat-dialog-container:has([data-pendo-id=\"save-panel-reasons-20240229\"]), .cdk-overlay-pane:has([data-pendo-id=\"save-panel-reasons-20240229\"])",
    paymentReasonsTab: "a[mat-tab-link]:has-text(\"Payment Reasons\"), .mat-tab-link:has-text(\"Payment Reasons\")",
    remarkCodesTab: "a[mat-tab-link]:has-text(\"Remark Codes\"), .mat-tab-link:has-text(\"Remark Codes\")",
    paymentReasonSearchInput: "input[data-pendo-id=\"reason-search-20240229\"]",
    remarkCodeSearchInput: ".rarc-body .rarc-code-field input, .mat-column-rarcCode input, .cdk-column-rarcCode input",
    resultRows: ".mat-autocomplete-panel [role=\"option\"], [role=\"listbox\"] [role=\"option\"]",
    saveButton: "button[data-pendo-id=\"save-panel-reasons-20240229\"]",
  },
  screenshots: {
    completedStateTarget: "body",
  },
};

export const REQUIRED_ADVANCEDMD_SELECTOR_KEYS = [
  "login.frame",
  "login.usernameInput",
  "login.passwordInput",
  "login.officeKeyInput",
  "login.pmRadio",
  "login.signInButton",
  "notifications.snoozeAllButton",
  "navigation.billingMenu",
  "navigation.quickPayMenuItem",
  "navigation.paymentEntryTab",
  "paymentEntry.eobSection",
  "paymentEntry.checkNumberInput",
  "paymentEntry.carrierInput",
  "paymentEntry.carrierDropdownOptions",
  "paymentEntry.checkAmountInput",
  "paymentEntry.depositDateInput",
  "paymentEntry.patientInput",
  "paymentEntry.patientDropdownOptions",
  "paymentEntry.visitClaimInput",
  "paymentEntry.visitClaimDropdownOptions",
  "paymentEntry.paymentAmountInput",
  "paymentEntry.remainingAmountValue",
  "paymentEntry.lineItemTable",
  "lineItems.row",
  "lineItems.dateCell",
  "lineItems.codeCell",
  "lineItems.chargeCell",
  "lineItems.insurancePortionCell",
  "lineItems.patientPortionCell",
  "lineItems.insuranceAllowedInput",
  "lineItems.insuranceNotAllowedCell",
  "lineItems.paymentInput",
  "lineItems.insuranceBalanceCell",
  "lineItems.patientBalanceCell",
  "lineItems.writeOffCodeCell",
  "lineItems.writeOffCell",
  "lineItems.statusDropdown",
  "lineItems.paymentReasonButton",
  "lineItems.riskCodeCell",
  "lineItems.riskAmountCell",
  "lineItems.providerCell",
  "paymentReasons.dialog",
  "paymentReasons.paymentReasonsTab",
  "paymentReasons.remarkCodesTab",
  "paymentReasons.paymentReasonSearchInput",
  "paymentReasons.remarkCodeSearchInput",
  "paymentReasons.resultRows",
  "paymentReasons.saveButton",
  "screenshots.completedStateTarget",
] as const;

export class AdvancedMdMissingSelectorError extends Error {
  constructor(readonly missingSelectors: string[]) {
    super(`AdvancedMD Payment Posting selector configuration is incomplete: ${missingSelectors.join(", ")}`);
    this.name = "AdvancedMdMissingSelectorError";
  }
}

export type AdvancedMdPreparedPaymentResult = {
  checkNumberEntered: string;
  carrierSelected: string;
  checkAmountEntered: string;
  depositDateEntered: string;
  patientSelected: string;
  patientIdSelected: string;
  visitClaimSelected: string;
  visitDateSelected: string;
  visitTimeSelected: string;
  visitDateCanonical: string;
  dosInputRaw: string;
  dosInputShortFormat: string;
  dosInputFullFormat: string;
  dosInputCanonical: string;
  visitOptionsFoundCount: string;
  visitOptionsFound: string;
  visitComparisonDetails: string;
  dosMatch: string;
  visitMatchResult: string;
  paymentAmountEntered: string;
  lineItemCode: string;
  lineItemCharge: string;
  lineMatchResult: string;
  insurancePortion: string;
  patientPortion: string;
  insuranceAllowedEntered: string;
  insuranceNotAllowed: string;
  paymentEntered: string;
  insuranceBalance: string;
  patientBalance: string;
  writeOffCode: string;
  writeOffAmount: string;
  riskCode: string;
  riskAmount: string;
  carcSelected: string;
  rarcSelected: string;
  reasonDescriptionSelected: string;
  denialCodeSelected: string;
  denialCodeDescription: string;
  finalDisplayedStatus: string;
  provider: string;
  displayedLineItems: DisplayedPaymentPostingLineItem[];
  screenshotFilename: string;
  screenshotPath: string;
  screenshotStatus: "Success";
};

export class AdvancedMdScreenshotError extends Error {
  constructor(message: string, readonly screenshotFilename: string, readonly screenshotPath: string) {
    super(message);
    this.name = "AdvancedMdScreenshotError";
  }
}

export type AdvancedMdPaymentEntryReadinessTiming = {
  quickPayClickedAt?: string;
  paymentIframeDetectedAt?: string;
  paymentEntryDomDetectedAt?: string;
  eobCheckVisibleAt?: string;
  eobCheckInteractableAt?: string;
  totalLoadDurationMs: number;
};

export type AdvancedMdPaymentEntryReadinessState = {
  found: boolean;
  visible: boolean;
  enabled: boolean;
};

export type AdvancedMdPaymentEntryFieldLog = {
  level?: "debug" | "info" | "warn" | "error";
  message: string;
  eventName?: string;
  meta?: Record<string, unknown>;
};

type AdvancedMdPaymentEntryFieldLogger = (event: AdvancedMdPaymentEntryFieldLog) => Promise<void>;

type VisitClaimControl = {
  wrapper: Locator;
  clickable: Locator;
  display: Locator;
  description: string;
};

type VisitDosFormats = {
  raw: string;
  short: string;
  full: string;
  canonical: string;
  fullYear: number;
};

type VisitOptionComparison = {
  optionText: string;
  visitClaimNumber: string;
  visitDateRaw: string;
  visitDateShort: string;
  visitDateFull: string;
  visitDateCanonical: string;
  visitTime: string;
  match: boolean;
  ignored: boolean;
};

type SelectedVisitClaim = {
  visitClaimNumber: string;
  visitDate: string;
  visitTime: string;
  visitDateCanonical: string;
  label: string;
  dosInputRaw: string;
  dosInputShortFormat: string;
  dosInputFullFormat: string;
  dosInputCanonical: string;
  optionsFoundCount: string;
  optionsFound: string;
  comparisonDetails: string;
  dosMatch: string;
  matchResult: string;
};

export class AdvancedMdPaymentEntryReadinessTimeoutError extends Error {
  constructor(
    message: string,
    readonly locatorState: AdvancedMdPaymentEntryReadinessState,
    readonly timing: AdvancedMdPaymentEntryReadinessTiming,
  ) {
    super(message);
    this.name = "AdvancedMdPaymentEntryReadinessTimeoutError";
  }
}

export class AdvancedMdVisitClaimNotFoundError extends Error {
  constructor(
    message: string,
    readonly visitComparison?: {
      dosInputRaw: string;
      dosInputShortFormat: string;
      dosInputFullFormat: string;
      dosInputCanonical: string;
      visitOptionsFoundCount: string;
      visitOptionsFound: string;
      visitComparisonDetails: string;
      dosMatch: string;
      visitMatchResult: string;
    },
  ) {
    super(message);
    this.name = "AdvancedMdVisitClaimNotFoundError";
  }
}

export class AdvancedMdPatientNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvancedMdPatientNotFoundError";
  }
}

export class AdvancedMdPatientNotSelectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvancedMdPatientNotSelectedError";
  }
}

const ADVANCEDMD_PAYMENT_ENTRY_READY_TIMEOUT_MS = 210000;
const ADVANCEDMD_EOB_CHECK_NUMBER_PENDO_ID = "eob-checknumber-single-search-input-20250104";

export function getMissingAdvancedMdSelectors(selectors: AdvancedMdSelectorConfig): string[] {
  return REQUIRED_ADVANCEDMD_SELECTOR_KEYS.filter((key) => !readSelector(selectors, key));
}

export function assertAdvancedMdSelectorsReady(selectors: AdvancedMdSelectorConfig): void {
  const missing = getMissingAdvancedMdSelectors(selectors);
  if (missing.length > 0) throw new AdvancedMdMissingSelectorError(missing);
}

export async function loginToAdvancedMd(page: Page, credentials: AdvancedMdPaymentPostingCredentials, selectors = ADVANCEDMD_PAYMENT_POSTING_SELECTORS): Promise<void> {
  assertRequiredSelectors(selectors, [
    "login.frame",
  ]);

  await page.goto(credentials.loginUrl || selectors.login.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator(selectors.login.frame).waitFor({ state: "attached", timeout: 90000 });
  const loginFrame = page.frameLocator(selectors.login.frame);
  await fillValue(await loginInput(loginFrame, selectors.login.usernameInput, 0), credentials.username);
  await fillValue(await loginInput(loginFrame, selectors.login.passwordInput, 1), credentials.password);
  if (credentials.officeKey) await fillValue(await loginInput(loginFrame, selectors.login.officeKeyInput, 2), credentials.officeKey);
  const pmRadio = await firstVisibleOptionalLocator([
    loginFrame.locator(selectors.login.pmRadio).first(),
    loginFrame.getByText("PM", { exact: true }).first(),
  ], 90000);
  if (!pmRadio) throw new Error("AdvancedMD PM option did not become visible after waiting for the login iframe.");
  await pmRadio.click();

  const signInButton = await firstVisibleOptionalLocator([
    loginFrame.locator(selectors.login.signInButton).first(),
    loginFrame.getByRole("button", { name: /log\s*in/i }).first(),
  ], 90000);
  if (!signInButton) throw new Error("AdvancedMD Log in button did not become visible after waiting for the login iframe.");
  await signInButton.click();
}

export async function dismissAdvancedMdNotifications(page: Page, selectors = ADVANCEDMD_PAYMENT_POSTING_SELECTORS): Promise<void> {
  if (!selectors.notifications.snoozeAllButton) return;
  const loginFrame = page.frameLocator(selectors.login.frame);
  const snoozeAll = await firstVisibleOptionalLocator([
    loginFrame.locator(selectors.notifications.snoozeAllButton).first(),
    loginFrame.getByRole("button", { name: /snooze\s+all/i }).first(),
    loginFrame.getByText(/snooze\s+all/i).first(),
    page.locator(selectors.notifications.snoozeAllButton).first(),
  ], 30000);
  if (!snoozeAll) return;

  const popupPromise = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);
  await snoozeAll.click();
  const popup = await popupPromise;
  if (popup) await popup.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
}

export async function resolveAdvancedMdAppPage(page: Page): Promise<Page> {
  const context = page.context();
  const appUrlPattern = /\/amds\/pm\/app\/index\.html/i;
  const existing = context.pages().find((candidate) => appUrlPattern.test(candidate.url()));
  if (existing) {
    await existing.bringToFront().catch(() => {});
    await existing.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    return existing;
  }

  const appPage = await context.waitForEvent("page", { timeout: 30000 }).catch(() => null);
  if (appPage && /advancedmd\.com/i.test(appPage.url())) {
    await appPage.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    await appPage.bringToFront().catch(() => {});
    if (appUrlPattern.test(appPage.url()) || /advancedmd\.com/i.test(appPage.url())) return appPage;
  }

  const newest = context.pages().filter((candidate) => /advancedmd\.com/i.test(candidate.url())).at(-1);
  if (newest) {
    await newest.bringToFront().catch(() => {});
    await newest.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    return newest;
  }

  await page.waitForURL(appUrlPattern, { timeout: 30000 }).catch(() => {});
  return page;
}

export async function openAdvancedMdQuickPay(page: Page, selectors = ADVANCEDMD_PAYMENT_POSTING_SELECTORS): Promise<Date> {
  assertRequiredSelectors(selectors, [
    "navigation.billingMenu",
    "navigation.quickPayMenuItem",
    "navigation.paymentEntryTab",
  ]);

  await page.bringToFront().catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await page.locator("a.dropdown-toggle[ng-bind=\"menuItem.title\"]").filter({ hasText: "Billing" }).first().waitFor({ state: "visible", timeout: 60000 });

  const billingMenu = await firstVisibleLocator([
    page.locator("a.dropdown-toggle[ng-bind=\"menuItem.title\"]").filter({ hasText: "Billing" }).first(),
    page.locator(selectors.navigation.billingMenu).first(),
    page.getByText("Billing", { exact: true }).first(),
  ]);
  await billingMenu.hover().catch(() => {});
  await billingMenu.click();

  const quickPay = await firstVisibleLocator([
    page.locator("li[ng-repeat=\"menuItem in subnav.menuItems track by $index\"] a[ng-bind=\"menuItem.title\"]").filter({ hasText: "Quick Pay" }).first(),
    page.locator(selectors.navigation.quickPayMenuItem).first(),
    page.getByText("Quick Pay", { exact: true }).first(),
  ]);
  await quickPay.click();
  const quickPayClickedAt = new Date();

  await firstVisibleLocator([
    page.locator(selectors.navigation.paymentEntryTab).first(),
    page.getByText("Payment Entry", { exact: true }).first(),
  ]);

  return quickPayClickedAt;
}

/**
 * Single explicit checkpoint confirming the Payment Entry screen is actually
 * ready before any field is touched. This waits on the real EOB Check # control
 * confirmed in the Payment Entry DOM and only returns when it is interactable.
 */
export async function waitForAdvancedMdPaymentEntryReady(
  page: Page,
  selectors: AdvancedMdSelectorConfig = ADVANCEDMD_PAYMENT_POSTING_SELECTORS,
  timeoutMs = ADVANCEDMD_PAYMENT_ENTRY_READY_TIMEOUT_MS,
  options: {
    quickPayClickedAt?: Date;
    onTiming?: (label: string, timing: AdvancedMdPaymentEntryReadinessTiming) => Promise<void>;
  } = {},
): Promise<AdvancedMdPaymentEntryReadinessTiming> {
  assertRequiredSelectors(selectors, [
    "paymentEntry.checkNumberInput",
  ]);

  const startedAt = options.quickPayClickedAt ?? new Date();
  const timing: AdvancedMdPaymentEntryReadinessTiming = {
    quickPayClickedAt: startedAt.toISOString(),
    totalLoadDurationMs: 0,
  };
  const eobCheckInput = eobCheckNumberReadinessInputLocator(page);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!timing.paymentIframeDetectedAt && await hasPaymentEntryIframe(page)) {
      timing.paymentIframeDetectedAt = new Date().toISOString();
      await options.onTiming?.("Payment iframe detected at", withLoadDuration(timing, startedAt));
    }

    const locatorState = await getAdvancedMdEobCheckReadinessState(eobCheckInput);
    if (locatorState.found && !timing.paymentEntryDomDetectedAt) {
      timing.paymentEntryDomDetectedAt = new Date().toISOString();
      await options.onTiming?.("Payment Entry DOM detected at", withLoadDuration(timing, startedAt));
    }
    if (locatorState.visible && !timing.eobCheckVisibleAt) {
      timing.eobCheckVisibleAt = new Date().toISOString();
      await options.onTiming?.("EOB Check # visible at", withLoadDuration(timing, startedAt));
    }
    if (locatorState.enabled) {
      timing.eobCheckInteractableAt = new Date().toISOString();
      await options.onTiming?.("EOB Check # interactable at", withLoadDuration(timing, startedAt));
      return withLoadDuration(timing, startedAt);
    }

    await page.waitForTimeout(Math.min(500, Math.max(1, deadline - Date.now())));
  }

  const locatorState = await getAdvancedMdEobCheckReadinessState(eobCheckInput);
  throw new AdvancedMdPaymentEntryReadinessTimeoutError(
    "AdvancedMD Payment Entry screen did not become ready because the EOB Check # control did not become interactable. No fields were filled for this row.",
    locatorState,
    withLoadDuration(timing, startedAt),
  );
}

function eobCheckNumberReadinessInputLocator(page: Page): Locator {
  const checkNumberControl = paymentFrame(page).locator(`[data-pendo-id="${ADVANCEDMD_EOB_CHECK_NUMBER_PENDO_ID}"]`).first();
  return checkNumberControl.locator("input").first();
}

function paymentFrame(page: Page): FrameLocator {
  return page.frameLocator("#frmPaymentEntry");
}

function paymentFrameInputByWrapperPendoId(page: Page, pendoId: string, label: string): Locator {
  return paymentFrame(page)
    .locator(`[data-pendo-id="${pendoId}"]`)
    .first()
    .locator("input")
    .first()
    .describe(`AdvancedMD Payment Entry ${label}: #frmPaymentEntry [data-pendo-id="${pendoId}"] input`);
}

async function paymentFrameInputByCandidates(label: string, candidates: Locator[]): Promise<Locator> {
  try {
    return await firstVisibleOrAttachedInputLocator(candidates, label);
  } catch (error) {
    throw new Error(
      `AdvancedMD input locator failed for ${label}. Payment Entry iframe locator candidates were not usable. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function eobCheckNumberReadinessDescription(): string {
  return paymentFrameWrapperPendoDescription(ADVANCEDMD_EOB_CHECK_NUMBER_PENDO_ID);
}

function paymentFrameWrapperPendoDescription(pendoId: string): string {
  return `frame #frmPaymentEntry [data-pendo-id="${pendoId}"] input`;
}

async function getAdvancedMdEobCheckReadinessState(input: Locator): Promise<AdvancedMdPaymentEntryReadinessState> {
  const found = await input.count().then((count) => count > 0).catch(() => false);
  if (!found) return { found: false, visible: false, enabled: false };

  const visible = await input.isVisible({ timeout: 250 }).catch(() => false);
  const enabled = visible && await input.isEnabled({ timeout: 250 }).catch(() => false);
  return { found, visible, enabled };
}

async function hasPaymentEntryIframe(page: Page): Promise<boolean> {
  return page.locator("#frmPaymentEntry").first().count().then((count) => count > 0).catch(() => false);
}

function withLoadDuration(
  timing: AdvancedMdPaymentEntryReadinessTiming,
  startedAt: Date,
): AdvancedMdPaymentEntryReadinessTiming {
  return {
    ...timing,
    totalLoadDurationMs: Date.now() - startedAt.getTime(),
  };
}

export async function prepareAdvancedMdPaymentPostingRow(options: {
  page: Page;
  credentials: AdvancedMdPaymentPostingCredentials;
  row: PaymentPostingInputRow;
  selectors?: AdvancedMdSelectorConfig;
  screenshotFolder: string;
  fieldLogger?: AdvancedMdPaymentEntryFieldLogger;
}): Promise<AdvancedMdPreparedPaymentResult> {
  const { page, row, screenshotFolder } = options;
  const selectors = options.selectors ?? ADVANCEDMD_PAYMENT_POSTING_SELECTORS;
  assertAdvancedMdSelectorsReady(selectors);

  // Explicit readiness checkpoint before touching a single field on this row.
  await waitForAdvancedMdPaymentEntryReady(page, selectors);

  const logField = (event: AdvancedMdPaymentEntryFieldLog) => options.fieldLogger?.(event) ?? Promise.resolve();
  const checkNumberInput = eobCheckNumberReadinessInputLocator(page);
  const carrierInput = paymentFrameInputByWrapperPendoId(page, "eob-carrier-input-search-20240229", "EOB Carrier");
  let checkAmountInput: Locator | null = null;
  let depositDateInput: Locator | null = null;

  await runPaymentEntryFieldStage(logField, row.inputRow, "Check #", "Filling Check #", "Check # filled", eobCheckNumberReadinessDescription(), async () => {
    await fillValue(checkNumberInput, row.checkNumber);
    await logField({
      level: "info",
      message: `AdvancedMD row ${row.inputRow}: Check # entered: ${row.checkNumber}`,
      eventName: "payment_posting_advancedmd_field_filled",
      meta: { field: "Check #", value: row.checkNumber },
    });
  });

  let carrierSelected = "";
  await runPaymentEntryFieldStage(logField, row.inputRow, "Carrier", "Filling Carrier", "Carrier selected", paymentFrameWrapperPendoDescription("eob-carrier-input-search-20240229"), async () => {
    carrierSelected = await fillCarrierAndConfirmSelected(page, carrierInput, selectors.paymentEntry.carrierDropdownOptions, row.carrier, logField, row.inputRow);
  });

  await runPaymentEntryFieldStage(logField, row.inputRow, "Check Amount", "Filling Check Amount", "Check Amount filled", "frame #frmPaymentEntry input[formcontrolname=\"eobCheckAmount\"]", async () => {
    const resolvedCheckAmountInput = await paymentFrameInputByCandidates("EOB Check Amount", [
      paymentFrame(page).locator("input[formcontrolname=\"eobCheckAmount\"]").first(),
      paymentFrame(page).locator("[formcontrolname=\"eobCheckAmount\"] input").first(),
    ]);
    checkAmountInput = resolvedCheckAmountInput;
    await fillValue(resolvedCheckAmountInput, formatCurrencyInput(row.checkAmount));
  });

  await runPaymentEntryFieldStage(logField, row.inputRow, "Deposit Date", "Filling Deposit Date", "Deposit Date filled", "frame #frmPaymentEntry [data-pendo-id=\"eob-check-deposit-date-20240229\"] input", async () => {
    const resolvedDepositDateInput = await paymentFrameInputByCandidates("EOB Deposit Date", [
      paymentFrameInputByWrapperPendoId(page, "eob-check-deposit-date-20240229", "EOB Deposit Date"),
      paymentFrame(page).locator("input[formcontrolname=\"eobDepositDate\"]").first(),
    ]);
    depositDateInput = resolvedDepositDateInput;
    await fillValue(resolvedDepositDateInput, normalizeAdvancedMdDate(row.checkDate));
  });

  const patientSelected = await runPaymentEntryFieldStage(logField, row.inputRow, "Patient", "Selecting Patient", "Patient selected", paymentFrameWrapperPendoDescription("payment-entry-patient-search-input-20240229"), async () => (
    selectPatientByNameAndId(page, selectors, row, logField)
  ));

  const selectedVisit = await runPaymentEntryFieldStage(logField, row.inputRow, "Visit/Claim #", "Resolving Visit/Claim control", "Visit/Claim selected", "frame #frmPaymentEntry Visit/Claim control", async () => {
    await waitForPatientDependentFieldsToStabilize(page, 7000);
    const visitControl = await resolveVisitClaimControlAfterPatient(page, logField, row.inputRow);
    return selectVisitClaimByDos(
      page,
      visitControl,
      selectors.paymentEntry.visitClaimDropdownOptions,
      row.visitDateDos,
      logField,
      row.inputRow,
    );
  });

  let paymentAmountInput: Locator | null = null;
  await runPaymentEntryFieldStage(logField, row.inputRow, "Payment Amount", "Filling Payment Amount", "Payment Amount filled", "frame #frmPaymentEntry .pf-payment-data-section input[formcontrolname=\"amount\"]", async () => {
    const resolvedPaymentAmountInput = await paymentFrameInputByCandidates("Payment Amount", [
      paymentFrame(page).locator(".pf-payment-data-section input[formcontrolname=\"amount\"]").first(),
      paymentFrame(page).locator(".pf-payment-data-section input[formcontrolname=\"paymentAmount\"]").first(),
    ]);
    paymentAmountInput = resolvedPaymentAmountInput;
    await fillValue(resolvedPaymentAmountInput, formatCurrencyInput(row.paymentAmount));
  });

  const displayedLineItems = await readDisplayedLineItems(page, selectors);
  const match = findLineItemMatch(displayedLineItems, row);
  if (match.type !== "unique") {
    throw new Error(`AdvancedMD line item match failed: ${match.type}`);
  }

  const matchedRow = paymentFrame(page).locator(selectors.lineItems.row).nth(Number(match.lineItem.rowId));
  const finalDisplayedStatusBeforeChanges = await readFinalStatus(matchedRow, selectors, "Bill Next");
  let insuranceAllowedEntered = "";
  if (row.allowedAmount) {
    const allowedAmount = row.allowedAmount;
    await runPaymentEntryFieldStage(logField, row.inputRow, "Insurance Allowed", "Filling Insurance Allowed", "Insurance Allowed filled", "frame #frmPaymentEntry matched line item Insurance Allowed input", async () => {
      insuranceAllowedEntered = formatCurrencyInput(allowedAmount);
      const insuranceAllowedInput = await firstVisibleLocator([
        matchedRow.locator(selectors.lineItems.insuranceAllowedInput).first(),
        rowGridInputByHeader(matchedRow, "Ins. Allowed"),
      ]);
      await fillValue(insuranceAllowedInput, insuranceAllowedEntered);
      insuranceAllowedEntered = await inputValue(insuranceAllowedInput);
    });
  }

  const paymentEntered = formatCurrencyInput(row.paymentAmount);
  let linePaymentInput: Locator | null = null;
  await runPaymentEntryFieldStage(logField, row.inputRow, "Line Payment", "Filling line-item Payment", "Line-item Payment filled", "frame #frmPaymentEntry matched line item Payment input", async () => {
    const resolvedLinePaymentInput = await firstVisibleLocator([
      matchedRow.locator(selectors.lineItems.paymentInput).first(),
      rowGridInputByHeader(matchedRow, "Payment"),
    ]);
    linePaymentInput = resolvedLinePaymentInput;
    await fillValue(resolvedLinePaymentInput, paymentEntered);
  });

  const { denialCodeSelected, denialCodeDescription } = await runPaymentEntryFieldStage(logField, row.inputRow, "Denial Code", "Handling Denial Code", "Denial Code handled", "frame #frmPaymentEntry matched line item payment reasons control", async () => (
    applyDenialCode(page, matchedRow, selectors, row)
  ));

  const screenshotFilename = buildPaymentPostingScreenshotFilename(row);
  const screenshotPath = path.join(screenshotFolder, screenshotFilename);
  await waitForCalculatedValuesToSettle(page);
  await captureAdvancedMdPaymentPostingScreenshot(page, screenshotFilename, screenshotPath);

  return {
    checkNumberEntered: await inputValue(checkNumberInput),
    carrierSelected,
    checkAmountEntered: await inputValue(requireResolvedLocator(checkAmountInput, "Check Amount")),
    depositDateEntered: await inputValue(requireResolvedLocator(depositDateInput, "Deposit Date")),
    patientSelected,
    patientIdSelected: extractSelectedPatientIdentifier(patientSelected, row),
    visitClaimSelected: selectedVisit.visitClaimNumber,
    visitDateSelected: selectedVisit.visitDate,
    visitTimeSelected: selectedVisit.visitTime,
    visitDateCanonical: selectedVisit.visitDateCanonical,
    dosInputRaw: selectedVisit.dosInputRaw,
    dosInputShortFormat: selectedVisit.dosInputShortFormat,
    dosInputFullFormat: selectedVisit.dosInputFullFormat,
    dosInputCanonical: selectedVisit.dosInputCanonical,
    visitOptionsFoundCount: selectedVisit.optionsFoundCount,
    visitOptionsFound: selectedVisit.optionsFound,
    visitComparisonDetails: selectedVisit.comparisonDetails,
    dosMatch: selectedVisit.dosMatch,
    visitMatchResult: selectedVisit.matchResult,
    paymentAmountEntered: await inputValue(requireResolvedLocator(paymentAmountInput, "Payment Amount")),
    lineItemCode: match.lineItem.code,
    lineItemCharge: match.lineItem.charge,
    lineMatchResult: "Unique CPT and charge match",
    insurancePortion: match.lineItem.insurancePortion ?? "",
    patientPortion: match.lineItem.patientPortion ?? "",
    insuranceAllowedEntered,
    insuranceNotAllowed: await textContent(matchedRow.locator(selectors.lineItems.insuranceNotAllowedCell).first()),
    paymentEntered: await inputValue(requireResolvedLocator(linePaymentInput, "Line Payment")),
    insuranceBalance: await textContent(matchedRow.locator(selectors.lineItems.insuranceBalanceCell).first()),
    patientBalance: await textContent(matchedRow.locator(selectors.lineItems.patientBalanceCell).first()),
    writeOffCode: await textContent(matchedRow.locator(selectors.lineItems.writeOffCodeCell).first()),
    writeOffAmount: await textContent(matchedRow.locator(selectors.lineItems.writeOffCell).first()),
    riskCode: await textContent(matchedRow.locator(selectors.lineItems.riskCodeCell).first()),
    riskAmount: await textContent(matchedRow.locator(selectors.lineItems.riskAmountCell).first()),
    carcSelected: "",
    rarcSelected: "",
    reasonDescriptionSelected: denialCodeDescription,
    denialCodeSelected,
    denialCodeDescription,
    finalDisplayedStatus: await readFinalStatus(matchedRow, selectors, finalDisplayedStatusBeforeChanges),
    provider: await textContent(matchedRow.locator(selectors.lineItems.providerCell).first()),
    displayedLineItems,
    screenshotFilename,
    screenshotPath,
    screenshotStatus: "Success",
  };
}

async function runPaymentEntryFieldStage<T>(
  logField: AdvancedMdPaymentEntryFieldLogger,
  inputRow: number,
  field: string,
  startMessage: string,
  successMessage: string,
  locatorDescription: string,
  action: () => Promise<T>,
): Promise<T> {
  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: ${startMessage}.`,
    eventName: "payment_posting_advancedmd_field_start",
    meta: { field, locator: locatorDescription },
  });

  try {
    const result = await action();
    await logField({
      level: "info",
      message: `AdvancedMD row ${inputRow}: ${successMessage}.`,
      eventName: "payment_posting_advancedmd_field_filled",
      meta: { field, locator: locatorDescription },
    });
    return result;
  } catch (error) {
    await logField({
      level: "error",
      message: `AdvancedMD row ${inputRow}: failed while processing ${field} using locator ${locatorDescription}. ${error instanceof Error ? error.message : String(error)}`,
      eventName: "payment_posting_advancedmd_field_failed",
      meta: { field, locator: locatorDescription },
    });
    throw error;
  }
}

function requireResolvedLocator(locator: Locator | null, label: string): Locator {
  if (locator) return locator;
  throw new Error(`AdvancedMD ${label} locator was not resolved before output values were read.`);
}

function patientResultOptions(page: Page, optionSelector: string): Locator {
  const cardSelectors = [
    optionSelector,
    ".patient-result",
    ".patient-card",
    ".lookup-result",
    ".result-card",
    ".search-result",
    "[class*=\"patient\"][class*=\"result\"]",
    "[class*=\"lookup\"][class*=\"result\"]",
    "[class*=\"result\"]",
  ].join(", ");
  return paymentFrame(page).locator(cardSelectors);
}

async function waitForPatientDropdownToClose(page: Page, optionSelector: string, timeoutMs: number): Promise<void> {
  const options = patientResultOptions(page, optionSelector);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await options.first().isVisible({ timeout: 250 }).catch(() => false)) return;
    await page.waitForTimeout(250);
  }
}

async function waitForPatientCommit(
  page: Page,
  patientInput: Locator,
  selectedLabel: string,
  patientName: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const committedPatient = await readCommittedPatientValue(page, patientInput);
    const dependentData = await isPatientDependentDataPopulated(page);
    if (dependentData && patientValuesMatch(committedPatient || selectedLabel, patientName)) return;
    await page.waitForTimeout(250);
  }
}

async function readCommittedPatientValue(page: Page, patientInput: Locator): Promise<string> {
  const frame = paymentFrame(page);
  const headerText = await textContent(frame.locator([
    ".tab-content",
    ".patient-header",
    ".patient-banner",
    "[class*=\"patient\"][class*=\"header\"]",
    "[class*=\"patient\"][class*=\"banner\"]",
    ".app-title",
    ".tab-pane",
    "body",
  ].join(", ")).filter({ hasText: "|" }).first());
  if (headerText) return headerText;
  return lookupDisplayedValue(patientInput);
}

async function isPatientFieldInvalid(patientInput: Locator): Promise<boolean> {
  return patientInput.evaluate((element) => {
    const target = element as HTMLElement;
    const wrapper = target.closest("mat-form-field, amds-patient-lookup-control, [data-pendo-id], .ng-invalid, .mat-form-field-invalid");
    if (!wrapper) return false;
    return wrapper.classList.contains("ng-invalid") ||
      wrapper.classList.contains("mat-form-field-invalid") ||
      wrapper.getAttribute("aria-invalid") === "true" ||
      target.getAttribute("aria-invalid") === "true";
  }).catch(() => false);
}

async function isPatientDependentDataPopulated(page: Page): Promise<boolean> {
  const frame = paymentFrame(page);
  const bodyText = await textContent(frame.locator("body").first());
  if (/\bchart\s*#\s+\d+/i.test(bodyText)) return true;
  if (/\bresponsible\s+party\s+\S+/i.test(bodyText)) return true;
  const chartInputValue = await frame.locator("xpath=//*[normalize-space(.)='Chart #']/following::input[1]").first().inputValue().catch(() => "");
  if (chartInputValue.trim()) return true;
  return !!await frame.locator("xpath=//*[contains(normalize-space(.),'Responsible Party')]/following::input[1]").first().inputValue().then((value) => value.trim()).catch(() => "");
}

async function waitForPatientDependentFieldsToStabilize(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPatientDependentDataPopulated(page)) {
      await page.waitForTimeout(500);
      return;
    }
    await page.waitForTimeout(250);
  }
}

async function resolveVisitClaimControlAfterPatient(
  page: Page,
  logField: AdvancedMdPaymentEntryFieldLogger,
  inputRow: number,
): Promise<VisitClaimControl> {
  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Resolving Visit/Claim control.`,
    eventName: "payment_posting_advancedmd_visit_claim_resolving_control",
    meta: { field: "Visit/Claim #" },
  });

  const frame = paymentFrame(page);
  const wrapperCandidates = [
    frame.locator("[data-pendo-id=\"payment-entry-visit-input-20240229\"]").first(),
    frame.locator("amds-visit-field").first(),
    frame.locator("[controlname*=\"visit\" i]").first(),
    frame.locator("[data-pendo-id*=\"visit\" i]").first(),
    frame.locator("xpath=//*[contains(normalize-space(.),'Visit/Claim #')]/following::*[self::amds-visit-field or self::*[@data-pendo-id] or self::input or self::button][1]").first(),
    frame.locator("xpath=//*[contains(normalize-space(.),'Visit/Claim #')]/ancestor::*[contains(@class,'form') or contains(@class,'field') or contains(@class,'section')][1]").first(),
  ];
  const wrapper = await firstExistingLocator(wrapperCandidates);

  const wrapperCount = await wrapper.count().catch(() => 0);
  const tagName = wrapperCount > 0
    ? await wrapper.evaluate((element) => element.tagName.toLowerCase()).catch(() => "")
    : "";
  const outerHTML = wrapperCount > 0
    ? await wrapper.evaluate((element) => element.outerHTML.slice(0, 1200)).catch(() => "")
    : "";
  const innerInputCount = wrapperCount > 0 ? await wrapper.locator("input").count().catch(() => 0) : 0;
  const clickableCount = wrapperCount > 0 ? await wrapper.locator("input, button, [role=\"button\"], .mat-icon, mat-icon, svg, [class*=\"search\" i], [class*=\"lookup\" i]").count().catch(() => 0) : 0;
  const displayedText = wrapperCount > 0 ? await textContent(wrapper) : "";
  const searchExists = wrapperCount > 0 ? await wrapper.locator("mat-icon, .mat-icon, svg, [class*=\"search\" i], [aria-label*=\"search\" i]").count().then((count) => count > 0).catch(() => false) : false;

  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Visit/Claim diagnostics before click.`,
    eventName: "payment_posting_advancedmd_visit_claim_diagnostics",
    meta: {
      field: "Visit/Claim #",
      wrapperCount,
      tagName,
      outerHTML,
      innerInputCount,
      clickableButtonOrIconCount: clickableCount,
      displayedText,
      searchExists,
    },
  });

  if (wrapperCount === 0) {
    throw new AdvancedMdVisitClaimNotFoundError("Visit/Claim control not found");
  }

  const clickable = await firstExistingLocator([
    wrapper.locator("input:not([type=\"hidden\"])").first(),
    wrapper.locator("button").first(),
    wrapper.locator("[role=\"button\"]").first(),
    wrapper.locator("mat-icon, .mat-icon, svg").first(),
    wrapper,
  ]);
  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Visit/Claim control found.`,
    eventName: "payment_posting_advancedmd_visit_claim_control_found",
    meta: {
      field: "Visit/Claim #",
      tagName,
      innerInputCount,
      clickableButtonOrIconCount: clickableCount,
      displayedText,
      searchExists,
    },
  });

  return {
    wrapper,
    clickable,
    display: wrapper,
    description: "frame #frmPaymentEntry Visit/Claim wrapper/control",
  };
}

async function firstExistingLocator(candidates: Locator[]): Promise<Locator> {
  for (const candidate of candidates) {
    if (await candidate.count().then((count) => count > 0).catch(() => false)) return candidate;
  }
  return candidates[candidates.length - 1];
}

/**
 * Types into the Patient search field without ever blurring it. The generic
 * fillValue() helper ends with a .blur() call, which is fine for plain text
 * inputs but is wrong here: AdvancedMD's Patient autocomplete panel only
 * stays open while this field keeps focus, and blurring closes it before a
 * result can be clicked. Focus must remain on this input for the entire
 * type -> wait-for-dropdown -> click-result sequence.
 */
async function fillPatientSearchKeepingFocus(patientInput: Locator, value: string): Promise<void> {
  await patientInput.waitFor({ state: "attached", timeout: 15000 });
  await patientInput.scrollIntoViewIfNeeded().catch(() => {});
  await patientInput.click({ force: true });
  await patientInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await patientInput.press("Backspace").catch(() => {});
  await patientInput.type(value, { delay: 20, timeout: 15000 });
  // No .blur() here on purpose — focus must stay on the field until a
  // dropdown result has actually been clicked below.
}

async function selectPatientByNameAndId(
  page: Page,
  selectors: AdvancedMdSelectorConfig,
  row: PaymentPostingInputRow,
  logField: AdvancedMdPaymentEntryFieldLogger,
): Promise<string> {
  const patientInput = await paymentFrameInputByCandidates("Patient", [
    paymentFrameInputByWrapperPendoId(page, "payment-entry-patient-search-input-20240229", "Patient"),
    paymentFrame(page).locator("amds-patient-lookup-control[controlname=\"patientLookup\"] input").first(),
    paymentFrame(page).locator("amds-patient-lookup-control input").first(),
  ]);

  await patientInput.waitFor({ state: "attached", timeout: 15000 });
  await patientInput.scrollIntoViewIfNeeded().catch(() => {});
  await patientInput.click({ force: true });
  await logField({
    level: "info",
    message: `AdvancedMD row ${row.inputRow}: Patient input focused.`,
    eventName: "payment_posting_advancedmd_patient_focused",
    meta: { field: "Patient" },
  });

  await fillPatientSearchKeepingFocus(patientInput, row.patientName);
  await logField({
    level: "info",
    message: `AdvancedMD row ${row.inputRow}: Patient search value: ${row.patientName}`,
    eventName: "payment_posting_advancedmd_patient_search",
    meta: { field: "Patient", searchValue: row.patientName },
  });

  await logField({
    level: "info",
    message: `AdvancedMD row ${row.inputRow}: Waiting for patient dropdown while keeping focus.`,
    eventName: "payment_posting_advancedmd_patient_waiting_dropdown",
    meta: { field: "Patient" },
  });
  const options = patientResultOptions(page, selectors.paymentEntry.patientDropdownOptions);
  await options.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const count = await options.count().catch(() => 0);
  await logField({
    level: "info",
    message: `AdvancedMD row ${row.inputRow}: Patient dropdown result count: ${count}`,
    eventName: "payment_posting_advancedmd_patient_result_count",
    meta: { field: "Patient", resultCount: count },
  });
  if (count === 0) {
    throw new AdvancedMdPatientNotFoundError(`Patient Not Found. No dropdown results appeared for "${row.patientName}".`);
  }

  // Matching priority:
  //   A. Exact name + a matching Patient ID / Control Number, when an
  //      identifier is actually displayed in the result — resolved
  //      immediately, no ambiguity possible.
  //   B. Exact normalized name when there is exactly one result and no
  //      identifier was available to check.
  //   C. Multiple same-name results with no identifier to disambiguate —
  //      reported as ambiguous rather than guessed.
  let selected: Locator | null = null;
  let selectedLabel = "";
  let ambiguous = false;
  const nameOnlyMatches: { option: Locator; label: string }[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (!await option.isVisible({ timeout: 250 }).catch(() => false)) continue;
    const label = await textContent(option);
    if (!label) continue;
    await logField({
      level: "info",
      message: `AdvancedMD row ${row.inputRow}: Patient candidate: ${label}`,
      eventName: "payment_posting_advancedmd_patient_candidate",
      meta: { field: "Patient", candidate: label },
    });
    const labelLower = label.toLowerCase();
    const patientIdMatches = row.patientId ? labelLower.includes(row.patientId.toLowerCase()) : false;
    const controlNumberMatches = row.patientControlNumber ? labelLower.includes(row.patientControlNumber.toLowerCase()) : false;
    if (patientIdMatches || controlNumberMatches) {
      selected = option;
      selectedLabel = label;
      break;
    }
    if (patientValuesMatch(label, row.patientName)) {
      nameOnlyMatches.push({ option, label });
    }
  }

  if (!selected) {
    if (nameOnlyMatches.length === 1) {
      selected = nameOnlyMatches[0].option;
      selectedLabel = nameOnlyMatches[0].label;
    } else if (nameOnlyMatches.length > 1) {
      ambiguous = true;
    }
  }

  if (ambiguous) {
    throw new AdvancedMdPatientNotFoundError(`Patient Ambiguous. Multiple dropdown results named "${row.patientName}" and no Patient ID / Control Number was displayed to tell them apart.`);
  }
  if (!selected) {
    throw new AdvancedMdPatientNotFoundError(`Patient Not Found. No dropdown result matched "${row.patientName}".`);
  }

  selectedLabel ||= await textContent(selected);
  await selected.click();
  await logField({
    level: "info",
    message: `AdvancedMD row ${row.inputRow}: Patient result clicked: ${selectedLabel}`,
    eventName: "payment_posting_advancedmd_patient_option_clicked",
    meta: {
      field: "Patient",
      option: selectedLabel,
      patientIdSelected: extractMatchedToken(selectedLabel, row.patientId),
      patientControlNumberSelected: extractMatchedToken(selectedLabel, row.patientControlNumber),
    },
  });
  await waitForPatientDropdownToClose(page, selectors.paymentEntry.patientDropdownOptions, 5000);
  await waitForPatientCommit(page, patientInput, selectedLabel, row.patientName, 7000);
  const finalPatient = await waitForLookupDisplayedValue(patientInput, row.patientName, 5000);
  const committedPatient = await readCommittedPatientValue(page, patientInput);
  const finalDisplay = committedPatient || finalPatient;
  const selectedLooksCorrect = patientValuesMatch(selectedLabel, row.patientName);
  const committedLooksCorrect = patientValuesMatch(finalDisplay, row.patientName);
  const invalid = await isPatientFieldInvalid(patientInput);
  const patientDataPopulated = await isPatientDependentDataPopulated(page);
  const success = selectedLooksCorrect && committedLooksCorrect && patientDataPopulated;
  await logField({
    level: "info",
    message: `AdvancedMD row ${row.inputRow}: Patient committed: ${finalDisplay || "(blank)"}.`,
    eventName: "payment_posting_advancedmd_patient_committed",
    meta: { field: "Patient", committed: finalDisplay },
  });
  await logField({
    level: success ? "info" : "error",
    message: `AdvancedMD row ${row.inputRow}: Patient selection ${success ? "success" : "failure"}.`,
    eventName: success ? "payment_posting_advancedmd_patient_selection_success" : "payment_posting_advancedmd_patient_selection_failed",
    meta: {
      field: "Patient",
      searchValue: row.patientName,
      optionSelected: selectedLabel,
      finalDisplayed: finalDisplay,
      patientIdSelected: extractMatchedToken(finalDisplay || selectedLabel, row.patientId),
      patientControlNumberSelected: extractMatchedToken(finalDisplay || selectedLabel, row.patientControlNumber),
      invalid,
      patientDataPopulated,
      success,
    },
  });
  if (!success) {
    throw new AdvancedMdPatientNotSelectedError(`Patient Not Selected. Expected "${row.patientName}", committed "${finalDisplay || "(blank)"}".`);
  }
  return finalDisplay;
}

async function selectVisitClaimByDos(
  page: Page,
  control: VisitClaimControl,
  optionSelector: string,
  excelDos: string,
  logField: AdvancedMdPaymentEntryFieldLogger,
  inputRow: number,
): Promise<SelectedVisitClaim> {
  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Clicking Visit/Claim.`,
    eventName: "payment_posting_advancedmd_visit_claim_clicking",
    meta: { field: "Visit/Claim #", locator: control.description },
  });
  await openLookupDropdown(control.clickable);
  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Visit/Claim clicked.`,
    eventName: "payment_posting_advancedmd_visit_claim_clicked",
    meta: { field: "Visit/Claim #", locator: control.description },
  });
  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Waiting for Visit/Claim dropdown.`,
    eventName: "payment_posting_advancedmd_visit_claim_waiting_dropdown",
    meta: { field: "Visit/Claim #" },
  });
  const options = await paymentEntryOptions(page, optionSelector);
  await options.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const count = await options.count().catch(() => 0);
  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Visit options found: ${count}.`,
    eventName: "payment_posting_advancedmd_visit_claim_result_count",
    meta: { field: "Visit/Claim #", resultCount: count, locator: control.description },
  });
  const dosFormats = buildVisitDosFormats(excelDos);
  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Excel DOS raw: ${dosFormats.raw}; short: ${dosFormats.short}; full: ${dosFormats.full}; canonical: ${dosFormats.canonical}.`,
    eventName: "payment_posting_advancedmd_visit_claim_dos_formats",
    meta: { field: "Visit/Claim #", ...dosFormats },
  });
  let selectedLabel = "";
  let selectedVisitDate = "";
  let selectedVisitClaimNumber = "";
  let selectedVisitTime = "";
  let selectedVisitDateCanonical = "";
  const comparisons: VisitOptionComparison[] = [];
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (!await option.isVisible({ timeout: 250 }).catch(() => false)) continue;
    const label = await textContent(option);
    if (isNonVisitOption(label)) continue;
    const visitDate = extractVisitDate(label);
    const visitClaimNumber = extractVisitClaimNumber(label);
    const visitTime = extractVisitTime(label);
    const comparison = compareVisitOptionToDos(label, dosFormats);
    comparisons.push(comparison);
    await logField({
      level: "info",
      message: `AdvancedMD row ${inputRow}: Visit option candidate: ${label}`,
      eventName: "payment_posting_advancedmd_visit_claim_candidate",
      meta: {
        field: "Visit/Claim #",
        option: label,
        visitClaimNumber,
        visitDate,
        visitTime,
        dosInput: excelDos,
        dosInputShort: dosFormats.short,
        dosInputFull: dosFormats.full,
        dosInputCanonical: dosFormats.canonical,
        visitDateCanonical: comparison.visitDateCanonical,
        dosMatch: comparison.match,
      },
    });
    if (comparison.match) {
      selectedLabel = label;
      selectedVisitDate = visitDate;
      selectedVisitClaimNumber = visitClaimNumber;
      selectedVisitTime = visitTime;
      selectedVisitDateCanonical = comparison.visitDateCanonical;
      await logField({
        level: "info",
        message: `AdvancedMD row ${inputRow}: DOS match found: ${selectedLabel}`,
        eventName: "payment_posting_advancedmd_visit_claim_dos_match_found",
        meta: {
          field: "Visit/Claim #",
          dosInput: excelDos,
          dosInputShort: dosFormats.short,
          dosInputFull: dosFormats.full,
          dosInputCanonical: dosFormats.canonical,
          visitClaimSelected: selectedVisitClaimNumber,
          visitDateSelected: selectedVisitDate,
          visitTimeSelected: selectedVisitTime,
          visitDateCanonical: selectedVisitDateCanonical,
          option: selectedLabel,
        },
      });
      await option.click();
      await logField({
        level: "info",
        message: `AdvancedMD row ${inputRow}: Visit/Claim option clicked: ${selectedLabel}`,
        eventName: "payment_posting_advancedmd_visit_claim_option_selected",
        meta: {
          field: "Visit/Claim #",
          dosInput: excelDos,
          visitClaimSelected: selectedVisitClaimNumber,
          visitDateSelected: selectedVisitDate,
          visitTimeSelected: selectedVisitTime,
          option: selectedLabel,
        },
      });
      break;
    }
  }

  await waitForVisitClaimDropdownToClose(page, optionSelector, 5000);
  const finalVisit = await waitForVisitClaimDisplayedValue(control.display, selectedLabel || selectedVisitClaimNumber, 5000);
  const fieldPopulated = !!normalizeLookupText(finalVisit);
  const finalVisitDate = extractVisitDate(finalVisit) || selectedVisitDate;
  const finalVisitClaimNumber = extractVisitClaimNumber(finalVisit) || selectedVisitClaimNumber;
  const finalVisitTime = extractVisitTime(finalVisit) || selectedVisitTime;
  const finalVisitDateCanonical = normalizeVisitDateCanonical(finalVisitDate || selectedVisitDate, dosFormats.fullYear) || selectedVisitDateCanonical;
  const success = fieldPopulated && !!finalVisitDateCanonical && finalVisitDateCanonical === dosFormats.canonical;
  await logField({
    level: success ? "info" : "error",
    message: `AdvancedMD row ${inputRow}: Final Visit/Claim displayed: ${finalVisit || selectedLabel || "(blank)"}. Visit/Claim selection ${success ? "success" : "failure"}.`,
    eventName: success ? "payment_posting_advancedmd_visit_claim_selection_success" : "payment_posting_advancedmd_visit_claim_selection_failed",
    meta: {
      field: "Visit/Claim #",
      dosInput: excelDos,
      visitClaimSelected: finalVisitClaimNumber,
      visitDateSelected: finalVisitDate,
      visitTimeSelected: finalVisitTime,
      visitDateCanonical: finalVisitDateCanonical,
      optionSelected: selectedLabel,
      finalDisplayed: finalVisit,
      success,
    },
  });
  if (!success) {
    throw new AdvancedMdVisitClaimNotFoundError(
      `Visit/Claim Not Found. Expected DOS "${excelDos}". Comparisons: ${formatVisitComparisonDetails(comparisons)}`,
      {
        dosInputRaw: dosFormats.raw,
        dosInputShortFormat: dosFormats.short,
        dosInputFullFormat: dosFormats.full,
        dosInputCanonical: dosFormats.canonical,
        visitOptionsFoundCount: String(comparisons.length),
        visitOptionsFound: comparisons.map((comparison) => comparison.optionText).join(" | "),
        visitComparisonDetails: formatVisitComparisonDetails(comparisons),
        dosMatch: "No",
        visitMatchResult: "Visit/Claim Not Found",
      },
    );
  }
  return {
    visitClaimNumber: finalVisitClaimNumber,
    visitDate: finalVisitDate,
    visitTime: finalVisitTime,
    visitDateCanonical: finalVisitDateCanonical,
    label: finalVisit || selectedLabel,
    dosInputRaw: dosFormats.raw,
    dosInputShortFormat: dosFormats.short,
    dosInputFullFormat: dosFormats.full,
    dosInputCanonical: dosFormats.canonical,
    optionsFoundCount: String(comparisons.length),
    optionsFound: comparisons.map((comparison) => comparison.optionText).join(" | "),
    comparisonDetails: formatVisitComparisonDetails(comparisons),
    dosMatch: "Yes",
    matchResult: "Matched by DOS",
  };
}

async function fillLookupAndSelect(
  page: Page,
  input: Locator,
  optionSelector: string,
  searchText: string,
  expectedText: string,
): Promise<string> {
  await fillValue(input, searchText);
  const options = await paymentEntryOptions(page, optionSelector);
  const option = options.filter({ hasText: expectedText }).first();
  await option.waitFor({ state: "visible", timeout: 15000 });
  const label = await textContent(option);
  await option.click();
  return label || expectedText;
}

async function fillCarrierAndConfirmSelected(
  page: Page,
  input: Locator,
  optionSelector: string,
  expectedCarrier: string,
  logField: AdvancedMdPaymentEntryFieldLogger,
  inputRow: number,
): Promise<string> {
  await logField({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Carrier search value: ${expectedCarrier}`,
    eventName: "payment_posting_advancedmd_carrier_search",
    meta: { field: "Carrier", searchValue: expectedCarrier },
  });
  await fillValue(input, expectedCarrier);

  let clickedOption = "";
  const options = await paymentEntryOptions(page, optionSelector);
  const optionCount = await options.count().catch(() => 0);
  if (optionCount > 0 && await options.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    const bestOption = await bestMatchingOption(options, expectedCarrier);
    if (bestOption) {
      clickedOption = await textContent(bestOption);
      await bestOption.click();
      await logField({
        level: "info",
        message: `AdvancedMD row ${inputRow}: Carrier option clicked: ${clickedOption}`,
        eventName: "payment_posting_advancedmd_carrier_option_clicked",
        meta: { field: "Carrier", option: clickedOption },
      });
    }
  }

  const finalCarrier = await waitForLookupDisplayedValue(input, expectedCarrier, 5000);
  const success = carrierValuesMatch(finalCarrier, expectedCarrier);
  await logField({
    level: success ? "info" : "error",
    message: `AdvancedMD row ${inputRow}: Final Carrier displayed: ${finalCarrier || "(blank)"}. Carrier selection ${success ? "success" : "failure"}.`,
    eventName: success ? "payment_posting_advancedmd_carrier_selection_success" : "payment_posting_advancedmd_carrier_selection_failed",
    meta: {
      field: "Carrier",
      searchValue: expectedCarrier,
      optionClicked: clickedOption,
      finalDisplayed: finalCarrier,
      success,
    },
  });
  if (!success) {
    throw new Error(`Carrier selection failed. Expected "${expectedCarrier}", displayed "${finalCarrier || "(blank)"}".`);
  }
  return finalCarrier;
}

async function bestMatchingOption(options: Locator, expectedText: string): Promise<Locator | null> {
  const count = await options.count().catch(() => 0);
  let firstVisible: Locator | null = null;
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (!await option.isVisible({ timeout: 250 }).catch(() => false)) continue;
    firstVisible ??= option;
    const label = await textContent(option);
    if (carrierValuesMatch(label, expectedText)) return option;
  }
  return firstVisible;
}

async function waitForLookupDisplayedValue(input: Locator, expectedValue: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    latest = await lookupDisplayedValue(input);
    if (carrierValuesMatch(latest, expectedValue)) return latest;
    await input.page().waitForTimeout(250);
  }
  return latest || await lookupDisplayedValue(input);
}

async function openLookupDropdown(input: Locator): Promise<void> {
  await input.waitFor({ state: "attached", timeout: 15000 });
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ force: true }).catch(() => {});
}

async function waitForVisitClaimDropdownToClose(page: Page, optionSelector: string, timeoutMs: number): Promise<void> {
  const options = await paymentEntryOptions(page, optionSelector);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await options.first().isVisible({ timeout: 250 }).catch(() => false)) return;
    await page.waitForTimeout(250);
  }
}

async function waitForVisitClaimDisplayedValue(display: Locator, expectedValue: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    latest = await visitClaimDisplayedValue(display);
    if (normalizeLookupText(latest) && (!expectedValue || normalizeLookupText(latest).includes(normalizeLookupText(expectedValue)))) return latest;
    await display.page().waitForTimeout(250);
  }
  return latest || await visitClaimDisplayedValue(display);
}

async function visitClaimDisplayedValue(display: Locator): Promise<string> {
  const inputValueText = await display.locator("input:not([type=\"hidden\"])").first().inputValue().catch(() => "");
  if (inputValueText.trim()) return inputValueText.trim();
  return textContent(display);
}

async function lookupDisplayedValue(input: Locator): Promise<string> {
  const value = await inputValue(input);
  if (value) return value;
  const text = await textContent(input.locator("xpath=ancestor::*[@data-pendo-id][1]").first());
  return text;
}

function carrierValuesMatch(actual: string, expected: string): boolean {
  const normalizedActual = normalizeLookupText(actual);
  const normalizedExpected = normalizeLookupText(expected);
  if (!normalizedActual || !normalizedExpected) return false;
  return normalizedActual === normalizedExpected ||
    normalizedActual.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedActual);
}

function patientValuesMatch(actual: string, expected: string): boolean {
  return carrierValuesMatch(actual, expected);
}

function extractMatchedToken(label: string, token: string | undefined): string {
  if (!token) return "";
  return label.toLowerCase().includes(token.toLowerCase()) ? token : "";
}

function normalizeLookupText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim()
    .toLowerCase();
}

async function paymentEntryOptions(page: Page, optionSelector: string): Promise<Locator> {
  const frameOptions = paymentFrame(page).locator(optionSelector);
  if (await frameOptions.first().isVisible({ timeout: 1000 }).catch(() => false)) return frameOptions;
  return page.locator(optionSelector);
}

async function readDisplayedLineItems(page: Page, selectors: AdvancedMdSelectorConfig): Promise<DisplayedPaymentPostingLineItem[]> {
  await paymentFrame(page).locator(selectors.paymentEntry.lineItemTable).first().waitFor({ state: "visible", timeout: 30000 });
  const rows = paymentFrame(page).locator(selectors.lineItems.row);
  const count = await rows.count();
  const lineItems: DisplayedPaymentPostingLineItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const code = await textContent(row.locator(selectors.lineItems.codeCell).first());
    const charge = await textContent(row.locator(selectors.lineItems.chargeCell).first());
    if (!code && !charge) continue;
    lineItems.push({
      rowId: String(index),
      code,
      charge,
      dos: await textContent(row.locator(selectors.lineItems.dateCell).first()),
      insurancePortion: await textContent(row.locator(selectors.lineItems.insurancePortionCell).first()),
      patientPortion: await textContent(row.locator(selectors.lineItems.patientPortionCell).first()),
      riskCode: await textContent(row.locator(selectors.lineItems.riskCodeCell).first()),
      riskAmount: await textContent(row.locator(selectors.lineItems.riskAmountCell).first()),
      provider: await textContent(row.locator(selectors.lineItems.providerCell).first()),
    });
  }
  return lineItems;
}

async function applyDenialCode(
  page: Page,
  matchedRow: Locator,
  selectors: AdvancedMdSelectorConfig,
  row: PaymentPostingInputRow,
): Promise<{ denialCodeSelected: string; denialCodeDescription: string }> {
  const denialCode = row.denialCode?.trim() ?? "";
  if (!denialCode) return { denialCodeSelected: "", denialCodeDescription: "" };

  await matchedRow.locator(selectors.lineItems.paymentReasonButton).first().click();
  await page.locator(selectors.paymentReasons.dialog).first().waitFor({ state: "visible", timeout: 15000 });
  await page.locator(selectors.paymentReasons.remarkCodesTab).first().click();
  const addRemark = page.locator("button[data-pendo-id=\"open-remark-20240229\"]").first();
  if (await addRemark.isVisible({ timeout: 3000 }).catch(() => false)) await addRemark.click();
  const remarkCodeInput = await firstVisibleLocator([
    page.locator(selectors.paymentReasons.remarkCodeSearchInput).first(),
    page.locator(".rarc-code-field input").first(),
  ]);
  const denialCodeDescription = await fillLookupAndSelect(
    page,
    remarkCodeInput,
    selectors.paymentReasons.resultRows,
    denialCode,
    denialCode,
  );

  await page.locator(selectors.paymentReasons.saveButton).first().click();
  await page.locator(selectors.paymentReasons.dialog).first().waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  return { denialCodeSelected: denialCode, denialCodeDescription };
}

async function loginInput(frame: FrameLocator, selector: string, fallbackIndex: number): Promise<Locator> {
  const locator = await firstVisibleOptionalLocator([
    frame.locator(selector).first(),
    frame.locator("input:not([type=\"hidden\"])").nth(fallbackIndex),
  ], 90000);
  if (!locator) throw new Error(`AdvancedMD login field ${fallbackIndex + 1} did not become visible after waiting for the login iframe.`);
  return locator;
}

async function inputBySelectorOrLabel(page: Page, selector: string, label: string): Promise<Locator> {
  return firstVisibleOrAttachedInputLocator([
    page.locator(selector).first(),
    page.locator(`.pf-payment-data-section mat-form-field:has(mat-label:text-is("${label}")) input:not([type="hidden"])`).first(),
    page.locator(`.eob mat-form-field:has(mat-label:text-is("${label}")) input:not([type="hidden"])`).first(),
    fieldInputByLabel(page, label),
    page.getByLabel(label, { exact: true }).first(),
  ], label);
}

function fieldInputByLabel(page: Page, label: string): Locator {
  return page.locator(`xpath=//mat-label[normalize-space(.)=${xpathLiteral(label)}]/ancestor::mat-form-field[1]//input[not(@type="hidden")]`).first();
}

function rowGridInputByHeader(row: Locator, header: string): Locator {
  const headerClass = header
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .split(/\s+/)
    .map((part, index) => index === 0 ? part.toLowerCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
    .join("");
  return row.locator(`.mat-column-${headerClass} input, .cdk-column-${headerClass} input`).first();
}

async function firstVisibleLocator(candidates: Locator[]): Promise<Locator> {
  const resolved = await firstVisibleOptionalLocator(candidates, 15000);
  if (resolved) return resolved;
  throw new Error("AdvancedMD locator resolution failed because none of the candidate locators became visible.");
}

async function firstVisibleOrAttachedInputLocator(candidates: Locator[], label: string): Promise<Locator> {
  const visible = await firstVisibleOptionalInputLocator(candidates, 10000);
  if (visible) return visible;

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const input = await attachedInputCandidate(candidate);
      if (input) return input;
    }
    await candidatePollPause(candidates[0]);
  }

  throw new Error(`AdvancedMD input locator failed for ${label}. None of the supplied selector or label candidates were found in the Payment Entry DOM.`);
}

async function firstVisibleOptionalInputLocator(candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const input = await visibleInputCandidate(candidate);
      if (input) return input;
    }
    await candidatePollPause(candidates[0]);
  }
  return null;
}

async function visibleInputCandidate(candidate: Locator): Promise<Locator | null> {
  const direct = candidate.first();
  if (await isUsableInput(direct, true)) return direct;

  for (const nested of nestedInputCandidates(candidate)) {
    if (await isUsableInput(nested, true)) return nested;
  }
  return null;
}

async function attachedInputCandidate(candidate: Locator): Promise<Locator | null> {
  const direct = candidate.first();
  if (await isUsableInput(direct, false)) return direct;

  for (const nested of nestedInputCandidates(candidate)) {
    if (await isUsableInput(nested, false)) return nested;
  }
  return null;
}

function nestedInputCandidates(candidate: Locator): Locator[] {
  return [
    candidate.locator("input:not([type=\"hidden\"])").first(),
    candidate.locator("textarea:not([type=\"hidden\"])").first(),
    candidate.locator("[contenteditable=\"true\"]").first(),
  ];
}

async function isUsableInput(locator: Locator, requireVisible: boolean): Promise<boolean> {
  const exists = await locator.count().then((count) => count > 0).catch(() => false);
  if (!exists) return false;
  const isInput = await locator.evaluate((element) => {
    const tag = element.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || element.getAttribute("contenteditable") === "true";
  }).catch(() => false);
  if (!isInput) return false;
  if (!requireVisible) return true;
  return locator.isVisible({ timeout: 250 }).catch(() => false);
}

async function candidatePollPause(candidate: Locator | undefined): Promise<void> {
  if (!candidate) return;
  await candidate.page().waitForTimeout(250);
}

async function firstVisibleOptionalLocator(candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) return candidate;
    }
  }
  return null;
}

async function firstAttachedOptionalLocator(candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await candidate.count().then((count) => count > 0).catch(() => false)) return candidate;
    }
    await candidatePollPause(candidates[0]);
  }
  return null;
}

async function waitForAdvancedMdPageLoadToSettle(page: Page, deadline: number): Promise<void> {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining <= 0) return;

  await page.waitForLoadState("domcontentloaded", { timeout: Math.min(10000, remaining) }).catch(() => {});
  const networkIdleRemaining = Math.max(0, deadline - Date.now());
  if (networkIdleRemaining > 0) {
    await page.waitForLoadState("networkidle", { timeout: Math.min(15000, networkIdleRemaining) }).catch(() => {});
  }
  const pauseRemaining = Math.max(0, deadline - Date.now());
  if (pauseRemaining > 0) await page.waitForTimeout(Math.min(500, pauseRemaining));
}

async function waitForCalculatedValuesToSettle(page: Page): Promise<void> {
  await page.waitForTimeout(1000);
}

export async function captureAdvancedMdPaymentPostingScreenshot(page: Page, screenshotFilename: string, screenshotPath: string): Promise<void> {
  try {
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AdvancedMdScreenshotError(message, screenshotFilename, screenshotPath);
  }
}

async function fillValue(locator: Locator, value: string): Promise<void> {
  await locator.waitFor({ state: "attached", timeout: 15000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ force: true }).catch(() => {});
  await locator.fill(value, { force: true }).catch(async () => {
    await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: 5000 }).catch(() => {});
    await locator.type(value, { delay: 15, timeout: 15000 });
  });
  const currentValue = await inputValue(locator);
  if (currentValue !== value) {
    await locator.evaluate((element, nextValue) => {
      const target = element as HTMLInputElement | HTMLTextAreaElement;
      target.value = nextValue;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }, value).catch(() => {});
  }
  await locator.blur().catch(() => {});
}

async function inputValue(locator: Locator): Promise<string> {
  return (await locator.inputValue().catch(() => ""))?.trim() ?? "";
}

async function readFinalStatus(row: Locator, selectors: AdvancedMdSelectorConfig, fallback: string): Promise<string> {
  const statusInput = row.locator(selectors.lineItems.statusDropdown).first();
  const value = await inputValue(statusInput);
  if (value) return value;
  const text = await textContent(row.locator(".mat-column-status, .cdk-column-status").first());
  return text || fallback;
}

async function textContent(locator: Locator): Promise<string> {
  const text = (await locator.textContent().catch(() => ""))?.replace(/\s+/g, " ").trim() ?? "";
  if (text) return text;
  const input = locator.locator("input").first();
  return (await input.inputValue().catch(() => ""))?.trim() ?? "";
}

function formatCurrencyInput(value: string): string {
  const cents = normalizeCurrencyCents(value);
  if (cents === null) return value.trim();
  return (cents / 100).toFixed(2);
}

function normalizeVisitDateForOption(value: string): string {
  const normalized = normalizeAdvancedMdDate(value);
  const match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return normalized.trim();
  return `${match[1]}/${match[2]}/${match[3].slice(-2)}`;
}

function buildVisitDosFormats(rawDos: string): VisitDosFormats {
  const normalized = normalizeAdvancedMdDate(rawDos);
  const parsed = parseDateParts(normalized) ?? parseDateParts(rawDos);
  if (!parsed) {
    return {
      raw: rawDos,
      short: normalized.trim(),
      full: normalized.trim(),
      canonical: normalized.trim(),
      fullYear: new Date().getFullYear(),
    };
  }

  return formatVisitDosParts(rawDos, parsed.month, parsed.day, parsed.year);
}

function parseDateParts(value: string): { month: number; day: number; year: number } | null {
  const trimmed = value.trim();
  let match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return {
      month: Number(match[2]),
      day: Number(match[3]),
      year: Number(match[1]),
    };
  }

  match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const rawYear = Number(match[3]);
  return {
    month: Number(match[1]),
    day: Number(match[2]),
    year: rawYear < 100 ? 2000 + rawYear : rawYear,
  };
}

function formatVisitDosParts(raw: string, month: number, day: number, year: number): VisitDosFormats {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const fullYear = String(year).padStart(4, "0");
  const shortYear = fullYear.slice(-2);
  return {
    raw,
    short: `${mm}/${dd}/${shortYear}`,
    full: `${mm}/${dd}/${fullYear}`,
    canonical: `${fullYear}-${mm}-${dd}`,
    fullYear: year,
  };
}

function compareVisitOptionToDos(optionText: string, dosFormats: VisitDosFormats): VisitOptionComparison {
  const visitDateRaw = extractVisitDateRaw(optionText);
  const visitClaimNumber = extractVisitClaimNumber(optionText);
  const visitTime = extractVisitTime(optionText);
  const visitDateShort = visitDateRaw ? normalizeVisitDateForOption(visitDateRaw) : "";
  const visitDateCanonical = normalizeVisitDateCanonical(visitDateRaw, dosFormats.fullYear);
  const visitDateFull = visitDateCanonical ? canonicalToFullVisitDate(visitDateCanonical) : "";
  const match = !!visitDateRaw && (
    visitDateShort === dosFormats.short ||
    visitDateFull === dosFormats.full ||
    visitDateCanonical === dosFormats.canonical
  );
  return {
    optionText,
    visitClaimNumber,
    visitDateRaw,
    visitDateShort,
    visitDateFull,
    visitDateCanonical,
    visitTime,
    match,
    ignored: false,
  };
}

function normalizeVisitDateCanonical(value: string, fallbackFullYear: number): string {
  const parsed = parseDateParts(value);
  if (!parsed) return "";
  const year = /\b\d{1,2}\/\d{1,2}\/\d{2}\b/.test(value.trim())
    ? centuryYearFromFallback(parsed.year, fallbackFullYear)
    : parsed.year;
  return formatVisitDosParts(value, parsed.month, parsed.day, year).canonical;
}

function centuryYearFromFallback(twoOrFullDigitYear: number, fallbackFullYear: number): number {
  if (twoOrFullDigitYear >= 100) return twoOrFullDigitYear;
  return Math.floor(fallbackFullYear / 100) * 100 + twoOrFullDigitYear;
}

function canonicalToFullVisitDate(canonical: string): string {
  const match = canonical.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : "";
}

function isNonVisitOption(optionText: string): boolean {
  return !extractVisitClaimNumber(optionText) || !extractVisitDateRaw(optionText);
}

function formatVisitComparisonDetails(comparisons: VisitOptionComparison[]): string {
  return comparisons.map((comparison) => (
    `${comparison.optionText} => Date ${comparison.visitDateRaw || "(none)"} => Canonical ${comparison.visitDateCanonical || "(none)"} => ${comparison.match ? "MATCH" : "NO MATCH"}`
  )).join("; ");
}

function extractVisitDate(optionLabel: string): string {
  const match = optionLabel.match(/\b(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\b/);
  return match ? normalizeVisitDateForOption(match[1]) : "";
}

function extractVisitDateRaw(optionLabel: string): string {
  const match = optionLabel.match(/\b(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\b/);
  return match?.[1] ?? "";
}

function extractVisitTime(optionLabel: string): string {
  const match = optionLabel.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i);
  return match?.[1]?.replace(/\s+/g, " ").toUpperCase() ?? "";
}

function extractVisitClaimNumber(optionLabel: string): string {
  const match = optionLabel.trim().match(/^([^-–—\s]+)/);
  return match?.[1] ?? optionLabel.trim();
}

function extractSelectedPatientIdentifier(patientLabel: string, row: PaymentPostingInputRow): string {
  const label = patientLabel.toLowerCase();
  if (row.patientControlNumber && label.includes(row.patientControlNumber.toLowerCase())) return row.patientControlNumber;
  if (row.patientId && label.includes(row.patientId.toLowerCase())) return row.patientId;
  return row.patientControlNumber || row.patientId;
}

function assertRequiredSelectors(selectors: AdvancedMdSelectorConfig, keys: readonly string[]): void {
  const missing = keys.filter((key) => !readSelector(selectors, key));
  if (missing.length > 0) throw new AdvancedMdMissingSelectorError(missing);
}

function readSelector(selectors: AdvancedMdSelectorConfig, key: string): string {
  return key.split(".").reduce<unknown>((value, part) => {
    if (value && typeof value === "object" && part in value) return (value as Record<string, unknown>)[part];
    return "";
  }, selectors) as string;
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("\"")) return `"${value}"`;
  return `concat('${value.replace(/'/g, "', \"'\", '")}')`;
}
