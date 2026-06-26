import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ScrapeJobEvent } from "../types/job";

export async function startScrapeJob(formData: FormData): Promise<string> {
  const response = await fetch("/api/scrape-jobs", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to start scrape job: ${response.status}`);
  }

  const body = await response.json() as { jobId?: string };
  if (!body.jobId) {
    throw new Error("Failed to start scrape job: missing jobId.");
  }

  return body.jobId;
}

export async function submitScrapeJobInput(options: { jobId: string; inputName: string; value: string }): Promise<void> {
  const response = await fetch("/api/scrape-jobs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Failed to submit job input: ${response.status}`);
  }
}

export async function subscribeToScrapeJobEvents(options: {
  jobId: string;
  signal: AbortSignal;
  onEvent: (event: ScrapeJobEvent) => Promise<void> | void;
  onStreamError: (error: unknown) => void;
}): Promise<void> {
  await fetchEventSource(`/api/scrape-jobs?jobId=${encodeURIComponent(options.jobId)}`, {
    openWhenHidden: true,
    signal: options.signal,
    async onmessage(ev) {
      if (ev.data === "" || ev.data.startsWith(":")) return;
      const eventData = JSON.parse(ev.data) as ScrapeJobEvent;
      await options.onEvent(eventData);
    },
    onerror(error) {
      options.onStreamError(error);
      throw error;
    },
  });
}
