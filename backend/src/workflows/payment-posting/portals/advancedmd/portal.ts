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
    insuranceTab: string;
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
    eobSection: ".eob amds-eob-check",
    checkNumberInput: "[data-pendo-id=\"eob-checknumber-single-search-input-20250104\"] input",
    carrierInput: "[data-pendo-id=\"eob-carrier-input-search-20240229\"] input",
    carrierDropdownOptions: ".mat-autocomplete-panel [role=\"option\"], [role=\"listbox\"] [role=\"option\"]",
    checkAmountInput: "input[formcontrolname=\"eobCheckAmount\"]",
    depositDateInput: "[data-pendo-id=\"eob-check-deposit-date-20240229\"] input.mat-input-element",
    insuranceTab: "[role=\"tab\"]:has-text(\"Insurance\"), button:has-text(\"Insurance\"), .mat-tab-label:has-text(\"Insurance\"), .tab:has-text(\"Insurance\")",
    patientInput: "amds-lookup-control[controlname=\"patient\"] input, [data-pendo-id*=\"patient\" i] input",
    patientDropdownOptions: ".mat-autocomplete-panel [role=\"option\"], [role=\"listbox\"] [role=\"option\"], .cdk-overlay-pane [role=\"option\"]",
    visitClaimInput: "amds-lookup-control[controlname*=\"visit\" i] input, [data-pendo-id*=\"visit\" i] input, [data-pendo-id*=\"claim\" i] input",
    visitClaimDropdownOptions: ".mat-autocomplete-panel [role=\"option\"], [role=\"listbox\"] [role=\"option\"], .cdk-overlay-pane [role=\"option\"]",
    paymentAmountInput: "input[formcontrolname=\"paymentAmount\"], input[formcontrolname*=\"payment\" i][amdsinputfilter=\"money\"]",
    remainingAmountValue: "input[formcontrolname*=\"remaining\" i], .remaining input, .remaining",
    lineItemTable: "table[mat-table]",
  },
  lineItems: {
    row: "tr[mat-row], .mat-row",
    dateCell: ".mat-column-date, .cdk-column-date",
    codeCell: ".mat-column-code, .cdk-column-code",
    chargeCell: ".mat-column-charge, .cdk-column-charge",
    insurancePortionCell: ".mat-column-insurancePortion, .cdk-column-insurancePortion, .mat-column-insPortion, .cdk-column-insPortion",
    patientPortionCell: ".mat-column-patientPortion, .cdk-column-patientPortion",
    insuranceAllowedInput: ".mat-column-insuranceAllowed input, .cdk-column-insuranceAllowed input",
    insuranceNotAllowedCell: ".mat-column-insuranceNotAllowed, .cdk-column-insuranceNotAllowed",
    paymentInput: ".mat-column-payment input, .cdk-column-payment input",
    insuranceBalanceCell: ".mat-column-insuranceBalance, .cdk-column-insuranceBalance",
    patientBalanceCell: ".mat-column-patientBalance, .cdk-column-patientBalance",
    writeOffCodeCell: ".mat-column-writeOffCode, .cdk-column-writeOffCode",
    writeOffCell: ".mat-column-writeOff, .cdk-column-writeOff",
    statusDropdown: ".mat-column-status input, .cdk-column-status input",
    paymentReasonButton: ".mat-column-carcRarc button, .cdk-column-carcRarc button",
    riskCodeCell: ".mat-column-riskCode, .cdk-column-riskCode",
    riskAmountCell: ".mat-column-riskAmount, .cdk-column-riskAmount",
    providerCell: ".mat-column-provider, .cdk-column-provider",
  },
  paymentReasons: {
    dialog: ".reason-panel, amds-payment-reasons, .mat-dialog-container:has([data-pendo-id=\"save-panel-reasons-20240229\"])",
    paymentReasonsTab: "button:has-text(\"Payment Reasons\"), .mat-tab-label:has-text(\"Payment Reasons\")",
    remarkCodesTab: "button:has-text(\"Remark Codes\"), .mat-tab-label:has-text(\"Remark Codes\")",
    paymentReasonSearchInput: "input[data-pendo-id=\"reason-search-20240229\"]",
    remarkCodeSearchInput: ".rarc-code-field input",
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
  "paymentEntry.insuranceTab",
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

export async function openAdvancedMdQuickPay(page: Page, selectors = ADVANCEDMD_PAYMENT_POSTING_SELECTORS): Promise<void> {
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

  await firstVisibleLocator([
    page.locator(selectors.navigation.paymentEntryTab).first(),
    page.getByText("Payment Entry", { exact: true }).first(),
  ]);
}

export async function prepareAdvancedMdPaymentPostingRow(options: {
  page: Page;
  credentials: AdvancedMdPaymentPostingCredentials;
  row: PaymentPostingInputRow;
  selectors?: AdvancedMdSelectorConfig;
  screenshotFolder: string;
}): Promise<AdvancedMdPreparedPaymentResult> {
  const { page, row, screenshotFolder } = options;
  const selectors = options.selectors ?? ADVANCEDMD_PAYMENT_POSTING_SELECTORS;
  assertAdvancedMdSelectorsReady(selectors);

  await firstVisibleLocator([
    page.locator(selectors.paymentEntry.insuranceTab).first(),
    page.getByRole("tab", { name: "Insurance" }).first(),
    page.getByText("Insurance", { exact: true }).first(),
  ]).then((locator) => locator.click());

  const checkNumberInput = await inputBySelectorOrLabel(page, selectors.paymentEntry.checkNumberInput, "Check #");
  const carrierInput = await inputBySelectorOrLabel(page, selectors.paymentEntry.carrierInput, "Carrier");
  const checkAmountInput = await inputBySelectorOrLabel(page, selectors.paymentEntry.checkAmountInput, "Check Amount");
  const depositDateInput = await inputBySelectorOrLabel(page, selectors.paymentEntry.depositDateInput, "Deposit Date");

  await fillValue(checkNumberInput, row.checkNumber);
  const carrierSelected = await fillLookupAndSelect(page, carrierInput, selectors.paymentEntry.carrierDropdownOptions, row.carrier, row.carrier);
  await fillValue(checkAmountInput, formatCurrencyInput(row.checkAmount));
  await fillValue(depositDateInput, normalizeAdvancedMdDate(row.checkDate));

  const patientSelected = await selectPatientByNameAndId(page, selectors, row);
  const visitClaimInput = await inputBySelectorOrLabel(page, selectors.paymentEntry.visitClaimInput, "Visit/Claim #");
  const selectedVisit = await selectVisitClaimByDos(
    page,
    visitClaimInput,
    selectors.paymentEntry.visitClaimDropdownOptions,
    row.visitDateDos,
  );
  const paymentAmountInput = await inputBySelectorOrLabel(page, selectors.paymentEntry.paymentAmountInput, "Payment Amount");
  await fillValue(paymentAmountInput, formatCurrencyInput(row.paymentAmount));

  const displayedLineItems = await readDisplayedLineItems(page, selectors);
  const match = findLineItemMatch(displayedLineItems, row);
  if (match.type !== "unique") {
    throw new Error(`AdvancedMD line item match failed: ${match.type}`);
  }

  const matchedRow = page.locator(selectors.lineItems.row).nth(Number(match.lineItem.rowId));
  const finalDisplayedStatusBeforeChanges = await readFinalStatus(matchedRow, selectors, "Bill Next");
  let insuranceAllowedEntered = "";
  if (row.allowedAmount) {
    insuranceAllowedEntered = formatCurrencyInput(row.allowedAmount);
    const insuranceAllowedInput = await firstVisibleLocator([
      matchedRow.locator(selectors.lineItems.insuranceAllowedInput).first(),
      rowGridInputByHeader(matchedRow, "Ins. Allowed"),
    ]);
    await fillValue(insuranceAllowedInput, insuranceAllowedEntered);
    insuranceAllowedEntered = await inputValue(insuranceAllowedInput);
  }

  const paymentEntered = formatCurrencyInput(row.paymentAmount);
  const linePaymentInput = await firstVisibleLocator([
    matchedRow.locator(selectors.lineItems.paymentInput).first(),
    rowGridInputByHeader(matchedRow, "Payment"),
  ]);
  await fillValue(linePaymentInput, paymentEntered);

  const { denialCodeSelected, denialCodeDescription } = await applyDenialCode(page, matchedRow, selectors, row);

  const screenshotFilename = buildPaymentPostingScreenshotFilename(row);
  const screenshotPath = path.join(screenshotFolder, screenshotFilename);
  await waitForCalculatedValuesToSettle(page);
  await captureCompletedPaymentScreenshot(page, screenshotFilename, screenshotPath);

  return {
    checkNumberEntered: await inputValue(checkNumberInput),
    carrierSelected,
    checkAmountEntered: await inputValue(checkAmountInput),
    depositDateEntered: await inputValue(depositDateInput),
    patientSelected,
    patientIdSelected: extractSelectedPatientIdentifier(patientSelected, row),
    visitClaimSelected: selectedVisit.visitClaimNumber,
    visitDateSelected: selectedVisit.visitDate,
    paymentAmountEntered: await inputValue(paymentAmountInput),
    lineItemCode: match.lineItem.code,
    lineItemCharge: match.lineItem.charge,
    lineMatchResult: "Unique CPT and charge match",
    insurancePortion: match.lineItem.insurancePortion ?? "",
    patientPortion: match.lineItem.patientPortion ?? "",
    insuranceAllowedEntered,
    insuranceNotAllowed: await textContent(matchedRow.locator(selectors.lineItems.insuranceNotAllowedCell).first()),
    paymentEntered: await inputValue(linePaymentInput),
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

async function selectPatientByNameAndId(
  page: Page,
  selectors: AdvancedMdSelectorConfig,
  row: PaymentPostingInputRow,
): Promise<string> {
  const patientInput = await inputBySelectorOrLabel(page, selectors.paymentEntry.patientInput, "Patient");
  await fillValue(patientInput, row.patientName);
  const options = page.locator(selectors.paymentEntry.patientDropdownOptions);
  await options.first().waitFor({ state: "visible", timeout: 15000 });
  const count = await options.count();
  let selected: Locator | null = null;
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const label = await textContent(option);
    const labelLower = label.toLowerCase();
    const patientIdMatches = row.patientId ? labelLower.includes(row.patientId.toLowerCase()) : false;
    const controlNumberMatches = row.patientControlNumber ? labelLower.includes(row.patientControlNumber.toLowerCase()) : false;
    if (patientIdMatches || controlNumberMatches) {
      selected = option;
      break;
    }
  }
  selected ??= options.first();
  const label = await textContent(selected);
  await selected.click();
  return label;
}

async function selectVisitClaimByDos(
  page: Page,
  input: Locator,
  optionSelector: string,
  excelDos: string,
): Promise<{ visitClaimNumber: string; visitDate: string; label: string }> {
  await fillValue(input, " ");
  const normalizedDos = normalizeVisitDateForOption(excelDos);
  const options = page.locator(optionSelector);
  await options.first().waitFor({ state: "visible", timeout: 15000 });
  const count = await options.count();
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const label = await textContent(option);
    const visitDate = extractVisitDate(label);
    if (visitDate && normalizeVisitDateForOption(visitDate) === normalizedDos) {
      await option.click();
      return {
        visitClaimNumber: extractVisitClaimNumber(label),
        visitDate,
        label,
      };
    }
  }
  throw new Error(`Visit/Claim option was not found for DOS ${excelDos}.`);
}

async function fillLookupAndSelect(
  page: Page,
  input: Locator,
  optionSelector: string,
  searchText: string,
  expectedText: string,
): Promise<string> {
  await fillValue(input, searchText);
  const option = page.locator(optionSelector).filter({ hasText: expectedText }).first();
  await option.waitFor({ state: "visible", timeout: 15000 });
  const label = await textContent(option);
  await option.click();
  return label || expectedText;
}

async function readDisplayedLineItems(page: Page, selectors: AdvancedMdSelectorConfig): Promise<DisplayedPaymentPostingLineItem[]> {
  await page.locator(selectors.paymentEntry.lineItemTable).first().waitFor({ state: "visible", timeout: 30000 });
  const rows = page.locator(selectors.lineItems.row);
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
  return firstVisibleLocator([
    page.locator(selector).first(),
    fieldInputByLabel(page, label),
    page.getByLabel(label, { exact: true }).first(),
  ]);
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
  for (const candidate of candidates) {
    if (await candidate.isVisible({ timeout: 2500 }).catch(() => false)) return candidate;
  }
  const last = candidates.at(-1);
  if (!last) throw new Error("AdvancedMD locator resolution failed because no candidates were provided.");
  await last.waitFor({ state: "visible", timeout: 15000 });
  return last;
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

async function waitForCalculatedValuesToSettle(page: Page): Promise<void> {
  await page.waitForTimeout(1000);
}

async function captureCompletedPaymentScreenshot(page: Page, screenshotFilename: string, screenshotPath: string): Promise<void> {
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
  await locator.waitFor({ state: "visible", timeout: 15000 });
  await locator.click().catch(() => {});
  await locator.fill(value);
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
  return (await locator.textContent().catch(() => ""))?.replace(/\s+/g, " ").trim() ?? "";
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

function extractVisitDate(optionLabel: string): string {
  const match = optionLabel.match(/\b(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\b/);
  return match ? normalizeVisitDateForOption(match[1]) : "";
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
