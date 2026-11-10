import { useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import {
  isAwsWorkflowMode, startScrapeJob,
  submitScrapeJobInput, subscribeToScrapeJobEvents,
} from "../../../../api/scrape-jobs-api";
import type { ErrorScreenshot, JobProgressValue, ScrapeJobEvent } from "../../../../types/job";
import {
  buildDownloadArtifactKey, downloadBlob, downloadTextFile, getErrorMessage, getEventRowIndex,
  hasDownloadedArtifact, rememberDownloadedArtifact,
} from "../../shared/artifacts";
import {
  loadUhcWorkbookBundle,
  type UhcWorkbookBundle,
} from "../../shared/workbook-files";
import { applyUhcRowUpdateToWorksheet, postProcessUhcWorksheet } from "./workbook";
import type { UhcProviderPrompt } from "./UhcResultView";
import type { PortalId } from "../../shared/model";

type Setter<T> = Dispatch<SetStateAction<T>>;

async function downloadUhcWorkbook(filename: string, workbookBundle: UhcWorkbookBundle): Promise<void> {
  postProcessUhcWorksheet(workbookBundle.worksheet);
  const buffer = await workbookBundle.excelWb.xlsx.writeBuffer();
  downloadBlob(filename, new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

export function useUhcController(p: {
  canStartAnotherRun: boolean;
  resetRunState: (message: string) => void;
  setSelectedPortalId: Setter<PortalId | null>;
  setActiveJobId: (jobId: string) => void; setIsProcessing: Setter<boolean>;
  setStatus: Setter<string>; setLogs: Setter<string[]>;
  setProgress: Setter<JobProgressValue | null>; setErrorScreenshots: Setter<ErrorScreenshot[]>;
  refreshRuns: () => void;
}) {
  const [uhcLoginFile, setUhcLoginFile] = useState<File | null>(null);
  const [uhcClaimFile, setUhcClaimFile] = useState<File | null>(null);
  const [uhcGroupId, setUhcGroupId] = useState("minimax");
  const [uhcBrowserType, setUhcBrowserType] = useState<"chrome" | "firefox">("chrome");
  const [uhcJobId, setUhcJobId] = useState("");
  const [uhcOtpRequest, setUhcOtpRequest] = useState<{ inputName: string; label: string; message: string } | null>(null);
  const [uhcOtpValue, setUhcOtpValue] = useState("");
  const [uhcProviderPrompt, setUhcProviderPrompt] = useState<UhcProviderPrompt | null>(null);
  const canSubmitUhc = useMemo(
    () => Boolean(uhcLoginFile && uhcClaimFile && p.canStartAnotherRun),
    [p.canStartAnotherRun, uhcClaimFile, uhcLoginFile],
  );
  const { resetRunState, setSelectedPortalId, setActiveJobId, setIsProcessing,
    setStatus, setLogs, setProgress, setErrorScreenshots } = p;
  const refreshWorkflowRuns = () => p.refreshRuns();

  function handleUhcClaimFileChange(file: File | null) {
    setUhcClaimFile(file);
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
    const submittedClientType = String(new FormData(e.currentTarget).get("clientType") || uhcGroupId)
      .trim()
      .toLowerCase();
    const clientType = submittedClientType === "medrevenu" ? "medrevenu" : "minimax";

    if (!uhcLoginFile || !uhcClaimFile) {
      setStatus("Please provide both the UHC login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting UHC scraper...");
    setSelectedPortalId("uhc");

    let workbookBundle: UhcWorkbookBundle;
    try {
      workbookBundle = await loadUhcWorkbookBundle(uhcClaimFile, clientType);
    } catch (error) {
      setStatus(`Unable to read UHC input files: ${getErrorMessage(error)}`);
      setIsProcessing(false);
      return;
    }

    const formData = new FormData();
    formData.append("portalId", "uhc");
    formData.append("loginExcel", uhcLoginFile);
    formData.append("claimExcel", uhcClaimFile);
    formData.append("loginFileName", uhcLoginFile.name);
    formData.append("claimFileName", uhcClaimFile.name);
    formData.append("claimRows", JSON.stringify(workbookBundle.claimRows));
    formData.append("startIndex", "0");
    formData.append("attempt", "1");
    formData.append("browserType", uhcBrowserType);
    formData.append("clientType", clientType);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    let uhcRowsSinceCheckpoint = 0;
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total });
      } else if (eventData.type === "row_update") {
        applyUhcRowUpdateToWorksheet(workbookBundle.worksheet, eventData);
        uhcRowsSinceCheckpoint += 1;
        const shouldDownloadFullUhcCheckpoint = !isAwsWorkflowMode() && uhcRowsSinceCheckpoint >= 10;
        if (shouldDownloadFullUhcCheckpoint) {
          uhcRowsSinceCheckpoint = 0;
          try {
            await downloadUhcWorkbook(`uhc_checkpoint_row_${(eventData.index ?? 0) + 1}.xlsx`, workbookBundle);
          } catch (downloadError) {
            finalErrorMessage = getErrorMessage(downloadError);
            setStatus(`UHC checkpoint download failed: ${finalErrorMessage}`);
            hasError = true;
          }
        }
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
      } else if (eventData.type === "input_consumed") {
        setUhcOtpRequest(null);
        setUhcProviderPrompt(null);
        setStatus("Verification response received. Processing resumed.");
        setLogs(prev => [...prev, "Verification response received. Processing resumed."]);
      } else if (eventData.type === "provider_options" && eventData.inputName) {
        setUhcOtpRequest(null);
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
      setUhcClaimFile(null);
      setIsProcessing(false);
      void refreshWorkflowRuns();
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

      if (!isAwsWorkflowMode()) {
        if (!hasError && !wasCancelled) {
          await downloadUhcWorkbook("uhc_output.xlsx", workbookBundle);
        } else if (uhcRowsSinceCheckpoint > 0) {
          await downloadUhcWorkbook("uhc_partial_output.xlsx", workbookBundle);
          uhcRowsSinceCheckpoint = 0;
        }
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
    uhcLoginFile, setUhcLoginFile, uhcClaimFile,
    uhcGroupId, setUhcGroupId, uhcBrowserType, setUhcBrowserType, uhcJobId, setUhcJobId,
    uhcOtpRequest, setUhcOtpRequest, uhcOtpValue, setUhcOtpValue, uhcProviderPrompt, setUhcProviderPrompt,
    canSubmitUhc, handleUhcClaimFileChange, submitUhcOtp, submitUhcProviderSelection, submitUhc,
  };
}
