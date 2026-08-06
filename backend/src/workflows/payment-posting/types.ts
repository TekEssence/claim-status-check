export const PAYMENT_POSTING_WORKFLOW_ID = "payment-posting" as const;

export const PAYMENT_POSTING_RESULT_VALUES = [
  "Filled - Not Posted",
  "Patient Not Found",
  "Patient ID Mismatch",
  "Visit/Claim Not Found",
  "Carrier Not Found",
  "CPT Not Matched",
  "Charge Not Matched",
  "CPT and Charge Not Matched",
  "Ambiguous Line Item Match",
  "Payment Reason Not Found",
  "Screenshot Failed",
  "Validation Failed",
  "Automation Failed",
  "Cancelled",
] as const;

export type PaymentPostingResultValue = (typeof PAYMENT_POSTING_RESULT_VALUES)[number];

export const PAYMENT_POSTING_DRY_RUN = {
  dryRun: true,
  posted: false,
} as const;

export const PROHIBITED_PAYMENT_POSTING_ACTIONS = [
  "Post",
  "Save and Post",
  "Submit Payment",
  "Finalize Payment",
] as const;

export const PROHIBITED_PAYMENT_POSTING_ACTION_IDS = [
  "post",
  "save-and-post",
  "submit-payment",
  "finalize-payment",
] as const;

export type PaymentPostingPortalConfig = {
  id: string;
  name: string;
  workflowId: typeof PAYMENT_POSTING_WORKFLOW_ID;
  dryRun: true;
  supportsScreenshots: boolean;
  supportsOutputWorkbook: boolean;
  supportsPosting: false;
  runtime: {
    supportsLocal: boolean;
    supportsDeployed: boolean;
    requiresVpn: boolean;
  };
};

export type PaymentPostingRunInput = {
  credentialExcel: File;
  inputExcel: File;
};

export type PaymentPostingCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  practice?: string;
  office?: string;
  provider?: string;
  raw: Record<string, string>;
};

export type PaymentPostingLineItemInput = {
  cpt: string;
  chargeAmount: string;
  allowedAmount?: string;
  paymentAmount: string;
  adjustment?: string;
  carc?: string;
  rarc?: string;
  denialCode?: string;
  denialReason?: string;
  remarkCode?: string;
  remarkReason?: string;
  adjustmentCode?: string;
  raDenialCode?: string;
  status?: string;
  modifier?: string;
  units?: string;
  provider?: string;
};

export type PaymentPostingInputRow = PaymentPostingLineItemInput & {
  inputRow: number;
  checkNumber: string;
  payerName: string;
  carrier: string;
  checkAmount: string;
  checkDate: string;
  patientName: string;
  patientId: string;
  patientControlNumber: string;
  visitClaimNumber: string;
  visitDateDos: string;
  raw: Record<string, string>;
  validationErrors: string[];
};

export type DisplayedPaymentPostingLineItem = {
  rowId: string;
  code: string;
  charge: string;
  insurancePortion?: string;
  patientPortion?: string;
  dos?: string;
  modifier?: string;
  units?: string;
  riskCode?: string;
  riskAmount?: string;
  provider?: string;
};

export type LineItemMatchOutcome =
  | {
      type: "no-match";
      cptMatched: boolean;
      chargeMatched: boolean;
      candidates: DisplayedPaymentPostingLineItem[];
    }
  | {
      type: "unique";
      cptMatched: true;
      chargeMatched: true;
      lineItem: DisplayedPaymentPostingLineItem;
    }
  | {
      type: "ambiguous";
      cptMatched: true;
      chargeMatched: true;
      candidates: DisplayedPaymentPostingLineItem[];
    };

export type PaymentPostingResultRow = {
  originalInput: Record<string, string>;
  inputRow: number;
  workflow: "Payment Posting";
  portal: string;
  jobId: string;
  dryRun: true;
  posted: false;
  checkNumberInput: string;
  checkNumberEntered: string;
  payerNameInput: string;
  carrierInput: string;
  carrierSelected: string;
  checkAmountInput: string;
  checkAmountEntered: string;
  checkEftDateInput: string;
  depositDateEntered: string;
  patientNameInput: string;
  patientIdInput: string;
  patientControlNumberInput: string;
  patientSelected: string;
  patientIdSelected: string;
  visitClaimInput: string;
  visitClaimSelected: string;
  visitDateDos: string;
  visitDateSelected: string;
  paymentAmountInput: string;
  paymentAmountEntered: string;
  excelCpt: string;
  lineItemCode: string;
  cptMatch: string;
  excelChargeAmount: string;
  lineItemCharge: string;
  chargeMatch: string;
  lineMatchResult: string;
  insurancePortion: string;
  patientPortion: string;
  allowedAmountInput: string;
  insuranceAllowedEntered: string;
  insuranceNotAllowed: string;
  paymentEntered: string;
  insuranceBalance: string;
  patientBalance: string;
  writeOffCode: string;
  writeOffAmount: string;
  adjustmentInput: string;
  riskCode: string;
  riskAmount: string;
  carcInput: string;
  carcSelected: string;
  rarcInput: string;
  rarcSelected: string;
  denialCodeInput: string;
  denialCodeSelected: string;
  denialCodeDescription: string;
  reasonDescriptionSelected: string;
  statusInput: string;
  finalDisplayedStatus: string;
  provider: string;
  screenshotFilename: string;
  screenshotPath: string;
  screenshotStatus: string;
  result: PaymentPostingResultValue;
  botMessage: string;
  errorDetails: string;
  startedAt: string;
  completedAt: string;
  processingTime: string;
  filledFields: string;
  skippedFields: string;
};

export type PaymentPostingResult = {
  rows: PaymentPostingResultRow[];
  outputWorkbookFilename: string;
  zipFilename: string;
};
