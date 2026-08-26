import { useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import {
  cancelScrapeJob as cancelScrapeJobRequest, startScrapeJob,
  submitScrapeJobInput, subscribeToScrapeJobEvents,
} from "../../../../api/scrape-jobs-api";
import type { FileSystemFileHandle } from "../../../../types/file-system-access";
import type { ErrorScreenshot, JobProgressValue, ScrapeJobEvent } from "../../../../types/job";
import {
  buildDownloadArtifactKey, downloadTextFile, getErrorMessage, getEventRowIndex,
  hasDownloadedArtifact, rememberDownloadedArtifact,
} from "../../shared/artifacts";
import {
  loadUhcWorkbookBundle, selectExcelFileHandle, writeWorkbookToClaimFile,
  type UhcWorkbookBundle,
} from "../../shared/workbook-files";
import { applyUhcRowUpdateToWorksheet, postProcessUhcWorksheet } from "./workbook";
import type { UhcProviderPrompt } from "./UhcResultView";
import type { PortalId } from "../../shared/model";

type Setter<T> = Dispatch<SetStateAction<T>>;

export function useUhcController(p: {
  canStartAnotherRun: boolean;
  resetRunState: (message: string) => void;
  setSelectedPortalId: Setter<PortalId | null>;
  setActiveJobId: Setter<string>; setIsProcessing: Setter<boolean>;
  setStatus: Setter<string>; setLogs: Setter<string[]>;
  setProgress: Setter<JobProgressValue | null>; setErrorScreenshots: Setter<ErrorScreenshot[]>;
  refreshRuns: () => void;
}) {
  const [uhcLoginFile, setUhcLoginFile] = useState<File | null>(null);
  const [uhcClaimFileHandle, setUhcClaimFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [uhcClaimFileName, setUhcClaimFileName] = useState("");
  const [uhcGroupId, setUhcGroupId] = useState("minimax");
  const [uhcBrowserType, setUhcBrowserType] = useState<"chrome" | "firefox">("chrome");
  const [uhcJobId, setUhcJobId] = useState("");
  const [uhcOtpRequest, setUhcOtpRequest] = useState<{ inputName: string; label: string; message: string } | null>(null);
  const [uhcOtpValue, setUhcOtpValue] = useState("");
  const [uhcProviderPrompt, setUhcProviderPrompt] = useState<UhcProviderPrompt | null>(null);
  const canSubmitUhc = useMemo(
    () => Boolean(uhcLoginFile && uhcClaimFileHandle && p.canStartAnotherRun),
    [p.canStartAnotherRun, uhcClaimFileHandle, uhcLoginFile],
  );
  const { resetRunState, setSelectedPortalId, setActiveJobId, setIsProcessing,
    setStatus, setLogs, setProgress, setErrorScreenshots } = p;
  const refreshWorkflowRuns = (_options?: { silent?: boolean }) => p.refreshRuns();

  async function selectUhcClaimFile() {
    try {
      const handle = await selectExcelFileHandle();
      if (!handle) return;
      const file = await handle.getFile();
      setUhcClaimFileHandle(handle);
      setUhcClaimFileName(file.name);
    } catch (error) {
      setStatus(`Unable to select UHC claim file: ${getErrorMessage(error)}`);
    }
  }

  async function submitUhcOtp() {
    if (!uhcJobId || !uhcOtpRequest || !uhcOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: uhcJobId,
        inputName: uhcOtpRequest.inputName,
        value: uhcOtpValue.trim(),
      });
      setUhcOtpRequest(null);
      setUhcOtpValue("");
      setStatus("UHC verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit UHC OTP: ${getErrorMessage(error)}`);
    }
  }

  async function submitUhcProviderSelection() {
    if (!uhcJobId || !uhcProviderPrompt?.value) return;

    const value = uhcProviderPrompt.providerStage === "corporate"
      ? JSON.stringify({ corporateTaxIdOwner: uhcProviderPrompt.value })
      : JSON.stringify({ careProvider: uhcProviderPrompt.value });

    try {
      await submitScrapeJobInput({
        jobId: uhcJobId,
        inputName: uhcProviderPrompt.inputName,
        value,
      });
      setUhcProviderPrompt(null);
      setStatus("UHC provider selection submitted.");
    } catch (error) {
      setStatus(`Failed to submit UHC provider selection: ${getErrorMessage(error)}`);
    }
  }

  async function submitUhc(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!uhcLoginFile || !uhcClaimFileHandle) {
      setStatus("Please provide both the UHC login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting UHC scraper...");
    setSelectedPortalId("uhc");

    let workbookBundle: UhcWorkbookBundle;
    try {
      workbookBundle = await loadUhcWorkbookBundle(uhcClaimFileHandle, uhcGroupId);
    } catch (error) {
      setStatus(`Unable to read UHC claim workbook: ${getErrorMessage(error)}`);
      setIsProcessing(false);
      return;
    }

    const formData = new FormData();
    formData.append("portalId", "uhc");
    formData.append("loginExcel", uhcLoginFile);
    formData.append("loginFileName", uhcLoginFile.name);
    formData.append("claimFileName", uhcClaimFileName);
    formData.append("claimRows", JSON.stringify(workbookBundle.claimRows));
    formData.append("startIndex", "0");
    formData.append("attempt", "1");
    formData.append("browserType", uhcBrowserType);
    formData.append("clientType", uhcGroupId);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    let writeQueue = Promise.resolve();
    let uhcRowsSinceCheckpoint = 0;
    const streamAbortController = new AbortController();

    const failForWriteError = (error: unknown) => {
      const message = `UHC Excel update failed. Close Excel, verify file access, and run again. Details: ${getErrorMessage(error)}`;
      hasError = true;
      setStatus(`Error: ${message}`);
      streamAbortController.abort();
      if (subscribedJobId) {
        void cancelScrapeJobRequest(subscribedJobId).catch((cancelError) => {
          console.error("Failed to cancel UHC job after Excel write failure", cancelError);
        });
      }
      window.alert(message);
    };

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total });
      } else if (eventData.type === "row_update") {
        applyUhcRowUpdateToWorksheet(workbookBundle.worksheet, eventData);
        uhcRowsSinceCheckpoint += 1;
        const shouldWriteFullUhcCheckpoint = uhcRowsSinceCheckpoint >= 10;
        if (shouldWriteFullUhcCheckpoint) {
          uhcRowsSinceCheckpoint = 0;
        }
        writeQueue = writeQueue.then(async () => {
          try {
            if (shouldWriteFullUhcCheckpoint) {
              postProcessUhcWorksheet(workbookBundle.worksheet);
            }
            await writeWorkbookToClaimFile(uhcClaimFileHandle, workbookBundle.excelWb);
          } catch (writeError) {
            failForWriteError(writeError);
          }
        });
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "debug_html" && typeof eventData.index === "number" && eventData.html) {
        const artifactKey = buildDownloadArtifactKey(eventData);
        if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
          const rowIndex = getEventRowIndex(eventData);
          downloadTextFile(eventData.filename || `uhc_debug_line_${rowIndex >= 0 ? rowIndex + 1 : "unknown"}.html`, eventData.html, "text/html");
          rememberDownloadedArtifact(subscribedJobId, artifactKey);
        }
      } else if (eventData.type === "otp_request" && eventData.inputName) {
        setUhcOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "UHC OTP",
          message: eventData.message || "Enter the UHC verification code.",
        });
        setUhcOtpValue("");
        setStatus(eventData.message || "Enter the UHC verification code.");
      } else if (eventData.type === "provider_options" && eventData.inputName) {
        const providerStage = eventData.providerStage === "care" ? "care" : "corporate";
        const options = providerStage === "corporate" ? eventData.corporateTaxIdOwners ?? [] : eventData.careProviders ?? [];
        setUhcProviderPrompt({
          inputName: eventData.inputName,
          providerStage,
          corporateTaxIdOwners: eventData.corporateTaxIdOwners ?? [],
          careProviders: eventData.careProviders ?? [],
          value: options[0] ?? "",
          label: eventData.label || (providerStage === "corporate" ? "Corporate Tax ID Owner" : "Care Provider"),
          message: eventData.message || "Select an option to continue UHC automation.",
        });
        setStatus(eventData.message || "Select an option to continue UHC automation.");
      } else if (eventData.type === "error" && eventData.message) {
        finalErrorMessage = eventData.message;
        setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
        setStatus(`Error: ${eventData.message}`);
        hasError = true;
      } else if (eventData.type === "cancelled") {
        wasCancelled = true;
        setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
        setStatus(eventData.message || "Processing cancelled.");
      }
    };

    try {
      const jobId = await startScrapeJob(formData);
      subscribedJobId = jobId;
      setActiveJobId(jobId);
      setUhcJobId(jobId);
      setUhcLoginFile(null);
      setUhcClaimFileHandle(null);
      setUhcClaimFileName("");
      setIsProcessing(false);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("UHC stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });

      await writeQueue;
      if (!hasError && !wasCancelled) {
        postProcessUhcWorksheet(workbookBundle.worksheet);
        await writeWorkbookToClaimFile(uhcClaimFileHandle, workbookBundle.excelWb);
      } else if (uhcRowsSinceCheckpoint > 0) {
        postProcessUhcWorksheet(workbookBundle.worksheet);
        await writeWorkbookToClaimFile(uhcClaimFileHandle, workbookBundle.excelWb);
        uhcRowsSinceCheckpoint = 0;
      }

      setStatus(
        wasCancelled
          ? "UHC processing cancelled."
          : hasError
            ? `UHC processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
            : "UHC processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process UHC claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
      setUhcJobId("");
    }
  }

  return {
    uhcLoginFile, setUhcLoginFile, uhcClaimFileHandle, uhcClaimFileName,
    uhcGroupId, setUhcGroupId, uhcBrowserType, setUhcBrowserType, uhcJobId, setUhcJobId,
    uhcOtpRequest, setUhcOtpRequest, uhcOtpValue, setUhcOtpValue, uhcProviderPrompt, setUhcProviderPrompt,
    canSubmitUhc, selectUhcClaimFile, submitUhcOtp, submitUhcProviderSelection, submitUhc,
  };
}
