export type AstronaCredentials = {
  group: string;
  payer: string;
  loginUrl: string;
  username: string;
  password: string;
};

export type AstronaInputRow = {
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

export type AstronaCredentialBatch = {
  credentials: AstronaCredentials;
  rows: AstronaInputRow[];
};

export type AstronaInput = {
  credentialWorkbookBuffer: ArrayBuffer;
  inputWorkbookBuffer: ArrayBuffer;
};

export type AstronaClaimDetails = {
  memberName?: string;
  memberDob?: string;
  claimNumber: string;
  datePaid: string;
  checkNumber: string;
  portalStatus: string;
  netAmount: string;
  cptCodes: string[];
  memoLine1: string;
  serviceLines: AstronaServiceLine[];
};

export type AstronaServiceLine = {
  from: string;
  to: string;
  cpt: string;
  modifier: string;
  diagCode: string;
  qty: string;
  billed: string;
  coPay: string;
  coInsure: string;
  deductible: string;
  adjustment: string;
  net: string;
  memoLine1: string;
};
