type StreamEvent = Record<string, unknown>;

export type ProcessClaimJobStatus = "running" | "done" | "error";

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
};

const jobs = new Map<string, ProcessClaimJob>();

function createJobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createProcessClaimJob(): ProcessClaimJob {
  const now = Date.now();
  const job: ProcessClaimJob = {
    id: createJobId(),
    status: "running",
    currentCompleted: 0,
    events: [],
    subscribers: new Set(),
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function getProcessClaimJob(jobId: string): ProcessClaimJob | undefined {
  return jobs.get(jobId);
}

export function emitProcessClaimEvent(jobId: string, data: StreamEvent): void {
  const job = jobs.get(jobId);
  if (!job) return;

  if (data.type === "progress" && typeof data.completed === "number") {
    job.currentCompleted = data.completed;
  }
  if (data.type === "done") {
    job.status = "done";
  }
  if (data.type === "error") {
    job.status = "error";
  }

  const event = {
    id: job.events.length + 1,
    data,
  };
  job.events.push(event);
  job.updatedAt = Date.now();
  job.subscribers.forEach((subscriber) => subscriber(event));
}

export function subscribeToProcessClaimJob(
  jobId: string,
  afterEventId: number,
  subscriber: (event: ProcessClaimJobEvent) => void,
): () => void {
  const job = jobs.get(jobId);
  if (!job) return () => {};

  job.events
    .filter((event) => event.id > afterEventId)
    .forEach((event) => subscriber(event));

  job.subscribers.add(subscriber);
  return () => {
    job.subscribers.delete(subscriber);
  };
}
