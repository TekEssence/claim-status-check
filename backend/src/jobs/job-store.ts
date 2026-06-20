import type {
  ScrapeJob,
  ScrapeJobEvent,
  ScrapeJobStatus,
  StreamEvent,
} from "./types";

export type {
  ScrapeJob,
  ScrapeJobEvent,
  ScrapeJobStatus,
  StreamEvent,
} from "./types";

const TERMINAL_JOB_TTL_MS = 30 * 60 * 1000;

const jobs = new Map<string, ScrapeJob>();

function isTerminalStatus(status: ScrapeJobStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function scheduleTerminalJobCleanup(job: ScrapeJob): void {
  if (!isTerminalStatus(job.status)) return;

  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
  }

  job.cleanupTimer = setTimeout(() => {
    const currentJob = jobs.get(job.id);
    if (!currentJob || !isTerminalStatus(currentJob.status)) return;

    currentJob.subscribers.clear();
    currentJob.events.length = 0;
    jobs.delete(job.id);
  }, TERMINAL_JOB_TTL_MS);
}

function createJobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createScrapeJob(): ScrapeJob {
  const now = Date.now();
  const job: ScrapeJob = {
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

export function getScrapeJob(jobId: string): ScrapeJob | undefined {
  return jobs.get(jobId);
}

export function emitScrapeJobEvent(jobId: string, data: StreamEvent): void {
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
  if (data.type === "cancelled") {
    job.status = "cancelled";
  }

  const event = {
    id: job.events.length + 1,
    data,
  };
  job.events.push(event);
  job.updatedAt = Date.now();
  job.subscribers.forEach((subscriber) => subscriber(event));

  if (isTerminalStatus(job.status)) {
    scheduleTerminalJobCleanup(job);
  }
}

export function subscribeToScrapeJob(
  jobId: string,
  afterEventId: number,
  subscriber: (event: ScrapeJobEvent) => void,
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
