export type MedpointCredentials = {
  loginUrl: string;
  username: string;
  password: string;
};

export type MedpointInputRow = {
  inputRowNumber: number;
  memberLastName: string;
  memberFirstName: string;
  serviceFromDate: string;
  serviceToDate: string;
  claimNumber: string;
  patientAccount: string;
};

export type MedpointParsedInput = {
  credentials: MedpointCredentials;
  inputFileName: string;
  rows: MedpointInputRow[];
};

export type MedpointOutputRow = {
  input_row_number: number;
  input_member_last_name: string;
  input_member_first_name: string;
  input_service_from_date: string;
  input_service_to_date: string;
  input_claim_number: string;
  ipa_context: string;
  search_result_index: number;
  portal_claim_number: string;
  portal_check_number: string;
  portal_date_received: string;
  portal_date_paid: string;
  portal_patient_account: string;
  portal_provider_name: string;
  detail_line_number: string;
  detail_raw_status: string;
  detail_net_amount: string;
  denial_code: string;
  denial_description: string;
  final_status: string;
  bot_notes: string;
};

export type MedpointAuditRow = {
  timestamp: string;
  stage: string;
  message: string;
  row_number?: number;
};

export type MedpointErrorRow = {
  input_row_number: number;
  stage: string;
  error: string;
};
