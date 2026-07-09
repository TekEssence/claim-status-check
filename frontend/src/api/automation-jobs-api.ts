import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ScrapeJobEvent } from "../types/job";

export async function startAutomationJob(formData: FormData): Promise<string> {
  const response = await fetch("/api/automation-jobs", { method: "POST", body: formData });
  const body = await response.json().catch(() => ({})) as { jobId?: string; error?: string };
  if (!response.ok || !body.jobId) {
    throw new Error(body.error || `Failed to start eligibility run: ${response.status}`);
  }
  return body.jobId;
}

export async function getCurrentAutomationJob() {
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
  if (!response.ok) throw new Error(body.error || "Unable to load the active eligibility run.");
  return body.job ?? null;
}

export async function cancelAutomationJob(jobId: string): Promise<void> {
  const response = await fetch(`/api/automation-jobs?jobId=${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "Unable to cancel the eligibility run.");
  }
}

export async function subscribeToAutomationJob(options: {
  jobId: string;
  signal: AbortSignal;
  onEvent: (event: ScrapeJobEvent) => void;
  onError: (error: unknown) => void;
}) {
  await fetchEventSource(
    `/api/automation-jobs?jobId=${encodeURIComponent(options.jobId)}`,
    {
      signal: options.signal,
      openWhenHidden: true,
      onmessage(message) {
        if (message.data) options.onEvent(JSON.parse(message.data) as ScrapeJobEvent);
      },
      onerror(error) {
        options.onError(error);
        return 2000;
      },
    },
  );
}
