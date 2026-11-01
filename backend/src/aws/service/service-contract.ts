export const SERVICE_WORKFLOW_IDS = {
  CLAIM_STATUS: "CLAIM_STATUS",
  ELIGIBILITY: "ELIGIBILITY",
  EOB_DOWNLOAD: "EOB_DOWNLOAD",
} as const;
export type ServiceWorkflowId = typeof SERVICE_WORKFLOW_IDS[keyof typeof SERVICE_WORKFLOW_IDS];

export type ServiceSubmitBody = {
  client_system?: unknown;
  client_execution_id?: unknown;
  idempotency_key?: unknown;
  deadline_at?: unknown;
  workflow?: unknown;
  portal?: unknown;
  projectId?: unknown;
  claims?: unknown;
  credentials?: unknown;
};

export type ServiceRowStatus = "SUCCESS" | "FAILED" | "NO_MATCH" | "ACTION_REQUIRED" | "INCOMPLETE";
export type ServiceOutcome = "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";
export type ServiceRowResult = {
  client_row_ref: string;
  status: ServiceRowStatus;
  result: { claim_status?: string; claim_details?: string; detail_rows?: Array<Record<string, string>>; [key: string]: unknown };
  error_category: string | null;
  error_message: string | null;
};
export type ServiceResultSummary = {
  outcome: ServiceOutcome;
  counts: { total: number; success: number; no_match: number; failed: number; action_required: number; incomplete: number };
  row_results: ServiceRowResult[];
  finalized_count: number;
};
