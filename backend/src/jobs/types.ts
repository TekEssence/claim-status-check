export type StreamEvent = Record<string, unknown>;

export type ProcessClaimJobStatus = "running" | "done" | "error" | "cancelled";

export type ProcessClaimJobEvent = {
  id: number;
  data: StreamEvent;
};

export type ProcessClaimJob = {
  id: string;
  status: ProcessClaimJobStatus;
  currentCompleted: number;
  events: ProcessClaimJobEvent[];
  subscribers: Set<(event: ProcessClaimJobEvent) => void>;
  createdAt: number;
  updatedAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};
