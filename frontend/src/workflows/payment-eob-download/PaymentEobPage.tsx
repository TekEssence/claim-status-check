"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, FileSpreadsheet, LoaderCircle, LogOut, ReceiptText } from "lucide-react";
import {
  cancelAutomationJob,
  getCurrentAutomationJob,
  startAutomationJob,
  submitAutomationJobInput,
  subscribeToAutomationJob,
} from "../../api/automation-jobs-api";
import { ActiveWorkflowRunsPanel } from "../../components/workflow-runs/ActiveWorkflowRunsPanel";
import { WorkflowOutputsPanel } from "../../components/workflow-runs/WorkflowOutputsPanel";
import type { JobProgressValue, ScrapeJobEvent } from "../../types/job";
import { getCognitoAccessToken, isCognitoMode, redirectToCognitoLogin, redirectToCognitoLogout, storeCognitoTokenFromHash } from "../../api/cognito-auth";
import { getPaymentEobPortal, paymentEobPortals } from "./registry";
import { PaymentEobInputForm } from "./portals/availity-remittance/PaymentEobInputForm";
import { PaymentEobResultView } from "./portals/availity-remittance/PaymentEobResultView";

type AuthUser = {
  username: string;
  email: string;
  mustResetPassword: boolean;
};

const WORKFLOW_ID = "payment-eob-download";

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const buffer = new ArrayBuffer(binaryString.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  return buffer;
}

function downloadBase64File(filename: string, base64: string, type: string): void {
  const url = URL.createObjectURL(new Blob([base64ToArrayBuffer(base64)], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

type PaymentEobPageProps = {
  portalId?: string;
};

export function PaymentEobPage({ portalId: initialPortalId }: PaymentEobPageProps) {
  const router = useRouter();
  const [selectedPortalId, setSelectedPortalId] = useState<string | null>(initialPortalId ?? null);
  const portal = getPaymentEobPortal(selectedPortalId);
  const requiresReferenceExcel = portal?.requiresReferenceExcel ?? true;
  const showReferenceExcel = requiresReferenceExcel || (portal && "acceptsReferenceExcel" in portal && portal.acceptsReferenceExcel);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [credentialFile, setCredentialFile] = useState<File | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<JobProgressValue | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [showOutputs, setShowOutputs] = useState(false);
  const [otpRequest, setOtpRequest] = useState<{ inputName: string; label: string; message: string } | null>(null);
  const [otpValue, setOtpValue] = useState("");
  const streamController = useRef<AbortController | null>(null);

  const canStart = Boolean(selectedPortalId && credentialFile && (!requiresReferenceExcel || referenceFile) && !isRunning);

  function resetPortalRunState() {
    streamController.current?.abort();
    setCredentialFile(null);
    setReferenceFile(null);
    setJobId("");
    setStatus("");
    setProgress(null);
    setLogs([]);
    setErrors([]);
    setIsRunning(false);
    setIsStopping(false);
    setOtpRequest(null);
    setOtpValue("");
  }

  function choosePortal(nextPortalId: string) {
    resetPortalRunState();
    setSelectedPortalId(nextPortalId);
  }

  function backFromPortal() {
    if (isRunning) return;
    resetPortalRunState();
    setSelectedPortalId(null);
  }

  const handleEvent = useCallback((event: ScrapeJobEvent) => {
    if (event.type === "log" && event.message) {
      setLogs((current) => [...current, event.message!]);
    } else if (event.type === "progress" && typeof event.completed === "number" && typeof event.total === "number") {
      setProgress({ completed: event.completed, total: event.total });
    } else if (event.type === "file_download" && event.filename && event.base64) {
      downloadBase64File(event.filename, event.base64, event.mimeType || "application/octet-stream");
      setLogs((current) => [...current, `Downloaded ${event.filename}.`]);
    } else if (event.type === "input_request" && event.inputName) {
      setOtpRequest({
        inputName: event.inputName,
        label: event.label || "InstaMed verification code",
        message: event.message || "Enter the InstaMed verification code sent by text message.",
      });
      setOtpValue("");
      setStatus(event.message || "Waiting for InstaMed verification code.");
    } else if (event.type === "error") {
      const message = event.message || "Payment EOB workflow failed.";
      setErrors((current) => [...current, message]);
      setStatus(message);
      setIsRunning(false);
    } else if (event.type === "cancelled") {
      setStatus(event.message || "Payment EOB job stopped.");
      setIsRunning(false);
      setIsStopping(false);
    } else if (event.type === "done") {
      setStatus((current) => current || "Payment EOB workflow shell completed.");
      setIsRunning(false);
      setIsStopping(false);
    }
  }, []);

  const connect = useCallback((nextJobId: string) => {
    streamController.current?.abort();
    const controller = new AbortController();
    streamController.current = controller;
    void subscribeToAutomationJob({
      jobId: nextJobId,
      signal: controller.signal,
      onEvent: handleEvent,
      onError: () => setStatus("Connection interrupted. Reconnecting..."),
    });
  }, [handleEvent]);

  useEffect(() => {
    if (isCognitoMode()) {
      const hasToken = storeCognitoTokenFromHash() || Boolean(getCognitoAccessToken());
      if (!hasToken) {
        redirectToCognitoLogin();
        return;
      }
      setUser({
        username: "Cognito user",
        email: "Signed in with Cognito",
        mustResetPassword: false,
      });
      setAuthLoading(false);
      return;
    }

    let active = true;
    fetch("/api/auth/me")
      .then(async (response) => {
        if (!response.ok) throw new Error("Authentication required.");
        return response.json() as Promise<{ user: AuthUser }>;
      })
      .then(({ user: nextUser }) => {
        if (!active) return;
        if (nextUser.mustResetPassword) {
          router.replace("/portal");
          return;
        }
        setUser(nextUser);
      })
      .catch(() => router.replace("/"))
      .finally(() => active && setAuthLoading(false));
    return () => {
      active = false;
      streamController.current?.abort();
    };
  }, [router]);

  useEffect(() => {
    if (!user) return;
    void getCurrentAutomationJob({ workflowId: WORKFLOW_ID, portalId: initialPortalId ?? undefined }).then((job) => {
      if (!job) return;
      setSelectedPortalId(job.portalId);
      setJobId(job.jobId);
      setLogs(job.logs.map((log) => log.message));
      setProgress(job.totalItems > 0 ? { completed: job.currentCompleted, total: job.totalItems } : null);
      setStatus("Reconnected to the active Payment EOB run.");
      setIsRunning(true);
      connect(job.jobId);
    }).catch(() => {});
  }, [user, connect, initialPortalId]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedPortalId || !credentialFile || (requiresReferenceExcel && !referenceFile)) return;

    setIsRunning(true);
    setStatus("Starting Payment EOB workflow...");
    setProgress(null);
    setLogs([]);
    setErrors([]);

    try {
      const formData = new FormData();
      formData.append("workflowId", WORKFLOW_ID);
      formData.append("portalId", selectedPortalId);
      formData.append("credentialExcel", credentialFile);
      if (referenceFile) {
        formData.append("referenceExcel", referenceFile);
      }
      const nextJobId = await startAutomationJob(formData);
      setJobId(nextJobId);
      connect(nextJobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start Payment EOB workflow.";
      setErrors((current) => [...current, message]);
      setStatus(message);
      setIsRunning(false);
    }
  }

  async function stop() {
    if (!jobId || isStopping) return;
    setIsStopping(true);
    setStatus("Stopping Payment EOB job...");
    try {
      await cancelAutomationJob(jobId);
      setStatus("Payment EOB stop requested.");
      setIsRunning(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to stop Payment EOB workflow.";
      setErrors((current) => [...current, message]);
      setStatus(message);
    } finally {
      setIsStopping(false);
    }
  }

  async function submitOtp() {
    if (!jobId || !otpRequest || !otpValue.trim()) return;
    try {
      await submitAutomationJobInput({
        jobId,
        inputName: otpRequest.inputName,
        value: otpValue.trim(),
      });
      setOtpRequest(null);
      setOtpValue("");
      setStatus("InstaMed verification code submitted.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to submit InstaMed verification code.";
      setErrors((current) => [...current, message]);
      setStatus(message);
    }
  }

  async function logout() {
    if (isCognitoMode()) {
      redirectToCognitoLogout();
      return;
    }
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/");
  }

  if (authLoading || !user) {
    return <main className="flex min-h-screen items-center justify-center"><LoaderCircle className="h-7 w-7 animate-spin text-blue-600" /></main>;
  }

  return (
    <main className="min-h-screen bg-[#f4f7fb] text-slate-900">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <button onClick={() => router.push("/portal")} className="flex items-center gap-3 text-left">
            <span className="relative h-11 w-11 overflow-hidden rounded-md border border-slate-200">
              <Image src="/opus-logo-2.jpg" alt="OPUS" fill className="object-contain p-1" />
            </span>
            <span>
              <span className="block text-sm font-semibold">Healthcare Automation</span>
              <span className="block text-xs text-slate-500">{user.email || user.username}</span>
            </span>
          </button>
          <button onClick={logout} title="Logout" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-5">
          <div>
            <p className="text-xs font-semibold uppercase text-blue-600">Payment EOB Download</p>
            <h1 className="mt-2 text-2xl font-semibold">{portal?.name ?? "Payment EOB Download"}</h1>
            <p className="mt-1 text-sm text-slate-600">
              {portal?.description ?? "Choose a payment portal to start remittance comparison and EOB download automation."}
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowOutputs((current) => !current)} className="inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"><FileSpreadsheet className="h-4 w-4" />Outputs</button>
            <button onClick={selectedPortalId ? backFromPortal : () => router.push("/portal")} disabled={Boolean(selectedPortalId && isRunning)} className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" />{selectedPortalId ? "Portals" : "Back"}</button>
          </div>
        </div>

        {showOutputs ? <WorkflowOutputsPanel workflowId={WORKFLOW_ID} title="Payment EOB Download outputs" /> : null}

        {!showOutputs ? <>
        <ActiveWorkflowRunsPanel
          currentWorkflowId={WORKFLOW_ID}
          currentPortalId={selectedPortalId ?? undefined}
        />

        {!selectedPortalId ? (
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            {paymentEobPortals.map((paymentPortal) => (
              <button
                key={paymentPortal.id}
                type="button"
                onClick={() => choosePortal(paymentPortal.id)}
                className="group flex min-h-48 flex-col border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:border-blue-400 hover:shadow-md"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-md bg-blue-100 text-blue-700">
                  <ReceiptText className="h-5 w-5" />
                </span>
                <h2 className="mt-5 text-xl font-semibold">{paymentPortal.name}</h2>
                <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{paymentPortal.description}</p>
                <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-blue-700">
                  Open portal
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
              <PaymentEobInputForm
                portalName={portal?.name ?? "Payment EOB"}
                credentialFileName={credentialFile?.name ?? ""}
                referenceFileName={referenceFile?.name ?? ""}
                requiresReferenceExcel={requiresReferenceExcel}
                showReferenceExcel={Boolean(showReferenceExcel)}
                isRunning={isRunning}
                canStart={canStart}
                onCredentialFileChange={setCredentialFile}
                onReferenceFileChange={setReferenceFile}
                onSubmit={start}
              />
            </div>
            <PaymentEobResultView
              jobId={jobId}
              status={status}
              progress={progress}
              logs={logs}
              errors={errors}
              canStop={Boolean(jobId && isRunning)}
              isStopping={isStopping}
              otpRequest={otpRequest}
              otpValue={otpValue}
              onOtpChange={setOtpValue}
              onOtpSubmit={submitOtp}
              onStop={stop}
            />
          </div>
        )}
        </> : null}
      </div>
    </main>
  );
}
