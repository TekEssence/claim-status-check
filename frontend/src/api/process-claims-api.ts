import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ProcessClaimEvent } from "../types/job";

export async function startProcessClaimsJob(formData: FormData): Promise<string> {
  const response = await fetch("/api/process-claims", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to start processing job: ${response.status}`);
  }

  const body = await response.json() as { jobId?: string };
  if (!body.jobId) {
    throw new Error("Failed to start processing job: missing jobId.");
  }

  return body.jobId;
}

export async function subscribeToProcessClaimEvents(options: {
  jobId: string;
  signal: AbortSignal;
  onEvent: (event: ProcessClaimEvent) => Promise<void> | void;
  onStreamError: (error: unknown) => void;
}): Promise<void> {
  await fetchEventSource(`/api/process-claims?jobId=${encodeURIComponent(options.jobId)}`, {
    openWhenHidden: true,
    signal: options.signal,
    async onmessage(ev) {
      if (ev.data === "" || ev.data.startsWith(":")) return;
      const eventData = JSON.parse(ev.data) as ProcessClaimEvent;
      await options.onEvent(eventData);
    },
    onerror(error) {
      options.onStreamError(error);
      throw error;
    },
  });
}
