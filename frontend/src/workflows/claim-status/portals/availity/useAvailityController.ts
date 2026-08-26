import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { getCurrentScrapeJob, submitScrapeJobInput } from "../../../../api/scrape-jobs-api";
import { downloadBase64File, getErrorMessage } from "../../shared/artifacts";
import type { DownloadableArtifact } from "../../shared/model";
import type { StandardPortalJobOptions } from "../../hooks/usePortalWorkflow";
import type { OtpRequest } from "../../hooks/useWorkflowPrompts";
import type { ScrapeJobEvent } from "../../../../types/job";

export function useAvailityController(p: {
  canStartAnotherRun: boolean;
  activeJobId: string;
  setStatus: (status: string) => void;
  resetRunState: (message: string) => void;
  runStandardPortalJob: (options: StandardPortalJobOptions) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState("minimax");
  const [credentialFile, setCredentialFile] = useState<File | null>(null);
  const [inputFile, setInputFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState("");
  const [otpRequest, setOtpRequest] = useState<OtpRequest | null>(null);
  const [otpValue, setOtpValue] = useState("");
  const [latestOutput, setLatestOutput] = useState<DownloadableArtifact | null>(null);
  const canSubmit = useMemo(
    () => Boolean(projectId && credentialFile && inputFile && p.canStartAnotherRun),
    [credentialFile, inputFile, p.canStartAnotherRun, projectId],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credentialFile || !inputFile) {
      p.setStatus("Please provide both the Availity login Excel and claim Excel files.");
      return;
    }
    p.resetRunState("Starting Availity scraper...");
    const formData = new FormData();
    formData.append("portalId", "availity");
    formData.append("projectId", projectId);
    formData.append("credentialExcel", credentialFile);
    formData.append("inputExcel", inputFile);
    formData.append("loginFileName", credentialFile.name);
    formData.append("claimFileName", inputFile.name);
    await p.runStandardPortalJob({
      portalName: "Availity",
      formData,
      onJobStarted: setJobId,
      onJobFinished: () => setJobId(""),
      onEvent: handleEvent,
      clearFiles: () => {
        setCredentialFile(null);
        setInputFile(null);
      },
    });
  }

  function handleEvent(event: ScrapeJobEvent) {
    if (event.type === "otp_request" && event.inputName) {
      setOtpRequest({
        inputName: event.inputName,
        label: event.label || "Availity OTP",
        message: event.message || "Enter the Availity verification code.",
      });
      setOtpValue("");
      p.setStatus(event.message || "Enter the Availity verification code.");
    } else if (event.type === "output_snapshot" && event.filename && event.base64) {
      setLatestOutput({
        filename: event.filename,
        base64: event.base64,
        mimeType: event.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        completed: event.completed,
        total: event.total,
      });
    } else if (event.type === "row_progress" && typeof event.current === "number" && typeof event.total === "number") {
      p.setStatus(`Availity processing row ${event.current} of ${event.total}: ${event.payerName || "Unknown payer"}${event.stage ? ` (${event.stage})` : ""}.`);
    }
  }

  async function submitOtp() {
    if (!jobId || !otpRequest || !otpValue.trim()) return;
    try {
      await submitScrapeJobInput({ jobId, inputName: otpRequest.inputName, value: otpValue.trim() });
      setOtpRequest(null);
      setOtpValue("");
      p.setStatus("Availity verification code submitted.");
    } catch (error) {
      p.setStatus(`Failed to submit Availity OTP: ${getErrorMessage(error)}`);
    }
  }

  async function downloadLatestOutput() {
    let output = latestOutput;
    const currentJob = await getCurrentScrapeJob().catch(() => null);
    const snapshot = [...(currentJob?.artifacts ?? [])].reverse()
      .find((artifact) => artifact.artifactType === "output_snapshot" && artifact.contentBase64 && artifact.filename);
    if (snapshot?.contentBase64 && snapshot.filename) {
      output = {
        filename: snapshot.filename,
        base64: snapshot.contentBase64,
        mimeType: snapshot.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        completed: currentJob?.currentCompleted,
        total: currentJob?.totalRows,
      };
      setLatestOutput(output);
    }
    if (!output) {
      p.setStatus("No Availity current-results workbook is available yet. Try again after the first row completes.");
      return;
    }
    const suffix = typeof output.completed === "number" && typeof output.total === "number"
      ? `-${output.completed}-of-${output.total}` : "";
    const filename = output.filename === "availity_output_snapshot.xlsx"
      ? `availity_claimstatus_partial${suffix}.xlsx` : output.filename;
    downloadBase64File(filename, output.base64, output.mimeType);
    p.setStatus(`Downloaded ${filename}`);
  }

  return {
    canSubmit, credentialFile, inputFile, projectId, jobId, latestOutput,
    otpRequest, otpValue, setCredentialFile, setInputFile, setProjectId, setJobId,
    setLatestOutput, setOtpRequest, setOtpValue, submit, submitOtp, downloadLatestOutput,
    canDownloadOutput: Boolean(latestOutput || p.activeJobId || jobId),
  };
}
