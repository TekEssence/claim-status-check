export type AvailityCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  totpSecret: string;
  successUrlFragment?: string;
};

export type AvailityInputRow = {
  input_row_id: number;
  source_row_number: number;
  data: Record<string, string>;
};

export type AvailityInput = {
  credentials: AvailityCredentials;
  projectId: string;
  inputHeaders: string[];
  inputRows: AvailityInputRow[];
  claimFileName: string;
};

export type AvailityProviderMapping = {
  project: string;
  group: string;
  providerName: string;
  active: boolean;
};

export type AvailityOutputRow = Record<string, string | number>;

export type AvailityErrorRow = {
  run_id: string;
  input_row_id: number | string;
  payer_name: string;
  claim_no: string;
  service_date: string;
  charges: string;
  search_source_tab: string;
  failure_stage: string;
  failure_reason: string;
  current_url: string;
  needs_manual_review: string;
};

export type AvailityAuditRow = {
  run_id: string;
  timestamp: string;
  input_row_id: number | string;
  payer_name: string;
  claim_no: string;
  step: string;
  status: string;
  duration_ms: number;
  retry_count: number;
  message: string;
};
