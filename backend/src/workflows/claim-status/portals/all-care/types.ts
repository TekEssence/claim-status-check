export type AllCareCredentials = {
  group: string;
  payer: string;
  loginUrl: string;
  username: string;
  password: string;
};

export type AllCareInputRow = {
  inputRowId: number;
  group: string;
  payer: string;
  memberId: string;
  memberName: string;
  dob: string;
  dos: string;
  cptCode: string;
  validationStatus: "valid" | "invalid";
  validationMessage: string;
};

export type AllCareCredentialBatch = {
  credentials: AllCareCredentials;
  rows: AllCareInputRow[];
};

export type AllCareInput = {
  credentialWorkbookBuffer: ArrayBuffer;
  inputWorkbookBuffer: ArrayBuffer;
};

export type AllCareClaimDetails = {
  vendorName?: string;
  checkAmount?: string;
  memberName?: string;
  memberDob?: string;
  claimNumber: string;
  dateReceived?: string;
  datePaid: string;
  dateDenied?: string;
  checkNumber: string;
  portalStatus: string;
  netAmount: string;
  cptCodes: string[];
  memoLine1: string;
  serviceLines: AllCareServiceLine[];
};

export type AllCareServiceLine = {
  claim?: string;
  vendorName?: string;
  dateReceived?: string;
  dateFinalized?: string;
  check?: string;
  checkAmount?: string;
  from: string;
  to: string;
  cpt: string;
  modifier: string;
  diagCode: string;
  qty: string;
  billed: string;
  allowed?: string;
  coPay: string;
  coInsure: string;
  deductible: string;
  seq?: string;
  adjustment: string;
  withhold?: string;
  interest?: string;
  net: string;
  carc?: string;
  rarc?: string;
  carcDescription?: string;
  rarcDescription?: string;
  memoLine1: string;
};
