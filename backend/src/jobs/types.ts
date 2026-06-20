export type StreamEvent = Record<string, unknown>;

export type ScrapeJobStatus = "running" | "done" | "error" | "cancelled";

export type ScrapeJobEvent = {
  id: number;
  data: StreamEvent;
};

export type ScrapeJob = {
  id: string;
  status: ScrapeJobStatus;
  currentCompleted: number;
  events: ScrapeJobEvent[];
  subscribers: Set<(event: ScrapeJobEvent) => void>;
  createdAt: number;
  updatedAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};
