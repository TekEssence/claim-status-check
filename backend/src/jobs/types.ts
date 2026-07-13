export type StreamEvent = Record<string, unknown>;

export type ScrapeJobStatus = "running" | "done" | "error" | "cancelled";

export type ScrapeJobEvent = {
  id: number;
  data: StreamEvent;
};

export type ScrapeJob = {
  id: string;
  workflowId: "claim-status" | "eligibility-verification";
  status: ScrapeJobStatus;
  currentCompleted: number;
  totalRows: number;
  cancelRequested: boolean;
  events: ScrapeJobEvent[];
  subscribers: Set<(event: ScrapeJobEvent) => void>;
  inputWaiters: Map<string, {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  createdAt: number;
  updatedAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};
