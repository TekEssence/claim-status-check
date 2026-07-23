"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, LogOut } from "lucide-react";
import {
  cancelAutomationJob,
  getCurrentAutomationJob,
  startAutomationJob,
  subscribeToAutomationJob,
} from "../../api/automation-jobs-api";
import type { JobProgressValue, ScrapeJobEvent } from "../../types/job";
import { getPaymentEobPortal } from "./registry";
import { PaymentEobInputForm } from "./portals/availity-remittance/PaymentEobInputForm";
import { PaymentEobResultView } from "./portals/availity-remittance/PaymentEobResultView";

type AuthUser = {
  username: string;
  email: string;
  mustResetPassword: boolean;
};

const WORKFLOW_ID = "payment-eob-download";
const PORTAL_ID = "availity-remittance";

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

export function PaymentEobPage() {
  const router = useRouter();
  const portal = getPaymentEobPortal(PORTAL_ID);
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
  const streamController = useRef<AbortController | null>(null);

  const canStart = Boolean(credentialFile && referenceFile && !isRunning);

  const handleEvent = useCallback((event: ScrapeJobEvent) => {
    if (event.type === "log" && event.message) {
      setLogs((current) => [...current, event.message!]);
    } else if (event.type === "progress" && typeof event.completed === "number" && typeof event.total === "number") {
      setProgress({ completed: event.completed, total: event.total });
    } else if (event.type === "file_download" && event.filename && event.base64) {
      downloadBase64File(event.filename, event.base64, event.mimeType || "application/octet-stream");
      setLogs((current) => [...current, `Downloaded ${event.filename}.`]);
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
    void getCurrentAutomationJob().then((job) => {
      if (!job || job.workflowId !== WORKFLOW_ID || job.portalId !== PORTAL_ID) return;
      setJobId(job.jobId);
      setLogs(job.logs.map((log) => log.message));
      setProgress(job.totalItems > 0 ? { completed: job.currentCompleted, total: job.totalItems } : null);
      setStatus("Reconnected to the active Payment EOB run.");
      setIsRunning(true);
      connect(job.jobId);
    }).catch(() => {});
  }, [user, connect]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credentialFile || !referenceFile) return;

    setIsRunning(true);
    setStatus("Starting Payment EOB workflow...");
    setProgress(null);
    setLogs([]);
    setErrors([]);

    try {
      const formData = new FormData();
      formData.append("workflowId", WORKFLOW_ID);
      formData.append("portalId", PORTAL_ID);
      formData.append("credentialExcel", credentialFile);
      formData.append("referenceExcel", referenceFile);
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

  async function logout() {
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
              {portal?.description ?? "Prepare Payment EOB download automation."}
            </p>
          </div>
          <button
            onClick={() => router.push("/portal")}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>

        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
            <PaymentEobInputForm
              credentialFileName={credentialFile?.name ?? ""}
              referenceFileName={referenceFile?.name ?? ""}
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
            onStop={stop}
          />
        </div>
      </div>
    </main>
  );
}
