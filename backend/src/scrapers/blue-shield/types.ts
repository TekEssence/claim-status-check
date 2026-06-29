export type BlueShieldCredentials = {
  group: string;
  loginUrl: string;
  username: string;
  password: string;
  claimStatusUrl: string;
  mailbox: string;
};

export type BlueShieldInputRow = Record<string, unknown> & {
  inputRowId: number;
  memberId: string;
  dos: string;
  validationStatus: "valid" | "invalid";
  validationMessage: string;
};

export type BlueShieldMemberWorkItem = {
  memberId: string;
  dosValues: string[];
  rowIds: number[];
  duplicateRowIds: number[];
};

export type BlueShieldInput = {
  credentials: BlueShieldCredentials;
  selectedGroup: string;
  inputWorkbookBuffer: ArrayBuffer;
  inputFileName: string;
  checkpointId: string;
  resetCheckpoint: boolean;
};

export type BlueShieldClaimSummary = {
  memberId: string;
  dosSearched: string;
  claimIndex: number;
  listClaimStatusLastModified: string;
  claimNumber: string;
  claimType: string;
  datesOfService: string;
  eob: string;
  memberName: string;
  listMemberIdSubscriberId: string;
  providerName: string;
  claimAmountBilled: string;
  claimAmountPaid: string;
  patientResponsibility: string;
  detailDatesOfService: string;
  claimReceived: string;
  detailProvider: string;
  providerNumber: string;
  nationalProviderIdentifier: string;
  ipaMedGroup: string;
  detailAmountBilled: string;
  allowedAmount: string;
  detailPatientResponsibility: string;
  detailAmountPaid: string;
  checkEftNumber: string;
  checkEftDate: string;
  checkEftStatus: string;
  checkEftAmount: string;
  payeeName: string;
  payeeAddress: string;
  serviceLineNumber: string;
  serviceLineDatesOfService: string;
  placeOfService: string;
  units: string;
  procedureCode: string;
  modifier: string;
  serviceLineAmountBilled: string;
  serviceLineAllowedAmount: string;
  serviceLineDeductible: string;
  serviceLineCopay: string;
  serviceLineCoInsurance: string;
  serviceLineAmountPaid: string;
  claimNotes: string;
  claimStatus: string;
  serviceDate: string;
  receivedDate: string;
  paidDate: string;
  billedAmount: string;
  paidAmount: string;
  detailsText: string;
  sourceUrl: string;
};

export type BlueShieldAuditRow = {
  timestamp: string;
  member_id: string;
  step: string;
  status: string;
  duration_ms: number;
  message: string;
};

export type BlueShieldErrorRow = {
  timestamp: string;
  member_id: string;
  dos: string;
  error_type: string;
  error_message: string;
  portal_url: string;
};
