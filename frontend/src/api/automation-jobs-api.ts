import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ScrapeJobEvent } from "../types/job";
import {
  cancelScrapeJob,
  isAwsWorkflowMode,
  listScrapeJobs,
  startScrapeJob,
  submitScrapeJobInput,
  subscribeToScrapeJobEvents,
} from "./scrape-jobs-api";

export type AutomationJobSummary = {
  jobId: string;
  workflowId: string;
  portalId: string;
  payerId: string | null;
  status: string;
  currentCompleted: number;
  totalItems: number;
  primaryInputFileName: string;
  credentialFileName: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export async function startAutomationJob(formData: FormData): Promise<string> {
  if (isAwsWorkflowMode()) {
    return startScrapeJob(formData);
  }

  const response = await fetch("/api/automation-jobs", { method: "POST", body: formData });
  const body = await response.json().catch(() => ({})) as { jobId?: string; error?: string };
  if (!response.ok || !body.jobId) {
    throw new Error(body.error || `Failed to start automation workflow: ${response.status}`);
  }
  return body.jobId;
}

export async function getCurrentAutomationJob() {
  if (isAwsWorkflowMode()) {
    const jobs = await listAutomationJobs(50);
    const job = jobs.find((candidate) => candidate.status === "queued" || candidate.status === "running" || candidate.status === "waiting_otp");
    return job ? { ...job, logs: [] as Array<{ message: string }> } : null;
  }

  const response = await fetch("/api/automation-jobs/current");
  if (response.status === 401) return null;
  const body = await response.json().catch(() => ({})) as {
    job?: {
      jobId: string;
      workflowId: string;
      portalId: string;
      payerId: string | null;
      status: string;
      currentCompleted: number;
      totalItems: number;
      logs: Array<{ message: string }>;
    } | null;
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || "Unable to load the active automation workflow.");
  return body.job ?? null;
}

export async function listAutomationJobs(limit = 25): Promise<AutomationJobSummary[]> {
  if (isAwsWorkflowMode()) {
    const jobs = await listScrapeJobs(limit);
    return jobs
      .filter((job) => job.workflowId === "eligibility-verification" || job.workflowId === "payment-eob-download" || job.workflowId === "payment-posting")
      .map((job) => ({
        jobId: job.jobId,
        workflowId: job.workflowId || "claim-status",
        portalId: job.portalId,
        payerId: null,
        status: job.status,
        currentCompleted: job.currentCompleted,
        totalItems: job.totalRows,
        primaryInputFileName: job.claimFileName,
        credentialFileName: job.loginFileName,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
      }));
  }

  const response = await fetch(`/api/automation-jobs/list?limit=${encodeURIComponent(String(limit))}`);
  if (response.status === 401) return [];
  const body = await response.json().catch(() => ({})) as {
    jobs?: AutomationJobSummary[];
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || `Failed to load eligibility jobs: ${response.status}`);
  return body.jobs ?? [];
}

export async function cancelAutomationJob(jobId: string): Promise<void> {
  if (isAwsWorkflowMode()) {
    await cancelScrapeJob(jobId);
    return;
  }

  const response = await fetch(`/api/automation-jobs?jobId=${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "Unable to cancel the automation workflow.");
  }
}

export async function submitAutomationJobInput(options: {
  jobId: string;
  inputName: string;
  value: string;
}): Promise<void> {
  if (isAwsWorkflowMode()) {
    await submitScrapeJobInput(options);
    return;
  }

  const response = await fetch("/api/automation-jobs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "Unable to submit automation workflow input.");
  }
}

export async function subscribeToAutomationJob(options: {
  jobId: string;
  signal: AbortSignal;
  onEvent: (event: ScrapeJobEvent) => void;
  onError: (error: unknown) => void;
}) {
  if (isAwsWorkflowMode()) {
    await subscribeToScrapeJobEvents({
      jobId: options.jobId,
      signal: options.signal,
      onEvent: options.onEvent,
      onStreamError: options.onError,
    });
    return;
  }

  await fetchEventSource(
    `/api/automation-jobs?jobId=${encodeURIComponent(options.jobId)}`,
    {
      signal: options.signal,
      openWhenHidden: true,
      onmessage(message) {
        if (message.data) options.onEvent(JSON.parse(message.data) as ScrapeJobEvent);
      },
      onclose() {
        if (!options.signal.aborted) throw new Error("Automation event stream closed before completion.");
      },
      onerror(error) {
        if (!options.signal.aborted) options.onError(error);
        return 2000;
      },
    },
  );
}
