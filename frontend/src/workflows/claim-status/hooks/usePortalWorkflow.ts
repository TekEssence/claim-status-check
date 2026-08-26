import type { Dispatch, SetStateAction } from "react";
import { startScrapeJob, subscribeToScrapeJobEvents } from "../../../api/scrape-jobs-api";
import type { ErrorScreenshot, JobProgressValue, ScrapeJobEvent } from "../../../types/job";
import {
  buildDownloadArtifactKey, downloadBase64File, getErrorMessage,
  hasDownloadedArtifact, rememberDownloadedArtifact,
} from "../shared/artifacts";

export type StandardPortalJobOptions = {
  portalName: string;
  formData: FormData;
  clearFiles: () => void;
  progressMessage?: (completed: number, total: number) => string;
  onEvent?: (event: ScrapeJobEvent) => void | Promise<void>;
  onJobStarted?: (jobId: string) => void;
  onJobFinished?: () => void;
};

export function usePortalWorkflow(p: {
  setActiveJobId: Dispatch<SetStateAction<string>>;
  setIsProcessing: Dispatch<SetStateAction<boolean>>;
  setLogs: Dispatch<SetStateAction<string[]>>;
  setProgress: Dispatch<SetStateAction<JobProgressValue | null>>;
  setErrorScreenshots: Dispatch<SetStateAction<ErrorScreenshot[]>>;
  setStatus: Dispatch<SetStateAction<string>>;
  refreshRuns: () => void;
}) {
  async function runStandardPortalJob(options: StandardPortalJobOptions): Promise<void> {
    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      await options.onEvent?.(eventData);
      if (eventData.type === "log" && eventData.message) {
        p.setLogs((previous) => [...previous, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        p.setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
        if (options.progressMessage) p.setStatus(options.progressMessage(eventData.completed, eventData.total));
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        p.setErrorScreenshots((previous) => [...previous, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
        const artifactKey = buildDownloadArtifactKey(eventData);
        if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
          downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
          rememberDownloadedArtifact(subscribedJobId, artifactKey);
          p.setStatus(`Downloaded ${eventData.filename}`);
        }
      } else if (eventData.type === "warning" && eventData.message) {
        p.setLogs((previous) => [...previous, eventData.message ?? ""]);
        p.setStatus(eventData.message);
      } else if (eventData.type === "error" && eventData.message) {
        finalErrorMessage = eventData.message;
        hasError = true;
        p.setLogs((previous) => [...previous, `ERROR: ${eventData.message}`]);
        p.setStatus(`Error: ${eventData.message}`);
      } else if (eventData.type === "cancelled") {
        wasCancelled = true;
        p.setLogs((previous) => [...previous, eventData.message || "Processing cancelled."]);
        p.setStatus(eventData.message || "Processing cancelled.");
      }
    };

    try {
      const jobId = await startScrapeJob(options.formData);
      subscribedJobId = jobId;
      p.setActiveJobId(jobId);
      options.onJobStarted?.(jobId);
      options.clearFiles();
      p.refreshRuns();
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          finalErrorMessage = getErrorMessage(error);
          hasError = true;
          p.setLogs((previous) => [...previous, `STREAM ERROR: ${finalErrorMessage}`]);
          p.setStatus(`Stream error: ${finalErrorMessage}`);
        },
      });
      p.setStatus(wasCancelled
        ? `${options.portalName} processing cancelled.`
        : hasError
          ? `${options.portalName} processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : `${options.portalName} processing completed.`);
    } catch (error) {
      p.setStatus(`Failed to process ${options.portalName} claims: ${getErrorMessage(error)}`);
    } finally {
      options.onJobFinished?.();
      p.setIsProcessing(false);
      p.setActiveJobId("");
    }
  }

  return { runStandardPortalJob };
}
