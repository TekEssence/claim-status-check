export type JobEvent = Record<string, unknown>;

export type LogEvent = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  eventName?: string;
  rowIndex?: number | string;
  meta?: Record<string, unknown>;
};

export const WORKFLOW_IDS = ["claim-status", "eligibility-verification"] as const;

export type WorkflowId = (typeof WORKFLOW_IDS)[number];

export type AutomationContext = {
  jobId: string;
  workflowId: WorkflowId;
  portalId: string;
  payerId?: string;
  log: (event: LogEvent) => Promise<void>;
  emit: (event: JobEvent) => Promise<void>;
  isCancelled?: () => boolean;
};

export interface AutomationRunner<TInput = unknown> {
  workflowId: WorkflowId;
  portalId: string;
  payerId?: string;
  name: string;
  validateInput(input: unknown): TInput;
  run(input: TInput, context: AutomationContext): Promise<void>;
}

export type WorkflowDefinition = {
  id: WorkflowId;
  name: string;
  getRunner: (portalId: string, payerId?: string) => AutomationRunner;
};
