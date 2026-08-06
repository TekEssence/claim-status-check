"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Building2,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Stethoscope,
} from "lucide-react";
import dashboardWelcomeImage from "../../Assets/ChatGPT Image Jul 1, 2026, 10_55_01 AM.png";
import {
  cancelAutomationJob,
  getCurrentAutomationJob,
  startAutomationJob,
  subscribeToAutomationJob,
} from "../../api/automation-jobs-api";
import {
  eligibilityPortals,
  getEligibilityPortal,
} from "./registry";
import type { ErrorScreenshot, JobProgressValue, ScrapeJobEvent } from "../../types/job";
import { WaystarInputForm } from "./portals/waystar/WaystarInputForm";
import { WaystarResultView } from "./portals/waystar/WaystarResultView";
import { AvailityInputForm } from "./portals/availity/AvailityInputForm";
import { UhcInputForm } from "./portals/uhc/UhcInputForm";

type AuthUser = {
  username: string;
  email: string;
  mustResetPassword: boolean;
};

type DownloadArtifact = {
  filename: string;
  base64: string;
  mimeType: string;
};

function downloadBase64File(filename: string, base64: string, mimeType: string): void {
  const binary = window.atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function EligibilityPage() {
  const router = useRouter();
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const portal = getEligibilityPortal(segments[1] ?? null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [inputFile, setInputFile] = useState<File | null>(null);
  const [credentialFile, setCredentialFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorScreenshots, setErrorScreenshots] = useState<ErrorScreenshot[]>([]);
  const [downloads, setDownloads] = useState<DownloadArtifact[]>([]);
  const [resultRows, setResultRows] = useState<Array<Record<string, string>>>([]);
  const [progress, setProgress] = useState<JobProgressValue | null>(null);
  const [hasCompleted, setHasCompleted] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const streamController = useRef<AbortController | null>(null);
  const jobFailed = useRef(false);

  const heading = portal?.name ?? "Eligibility Verification";
  const canStart = Boolean(portal && inputFile && credentialFile && !isRunning);

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

  const handleEvent = useCallback((event: ScrapeJobEvent) => {
    if (event.type === "log" && event.message) setLogs((current) => [...current, event.message!]);
    if (event.type === "progress" && typeof event.completed === "number" && typeof event.total === "number") {
      setProgress({ completed: event.completed, total: event.total });
    }
    if (event.type === "error_screenshot" && typeof event.image === "string" && event.image) {
      setErrorScreenshots((current) => [...current, { index: typeof event.index === "number" ? event.index : -1, image: event.image! }]);
    }
    if (event.type === "eligibility_availity_result" && event.update) {
      const result = Object.fromEntries(
        Object.entries(event.update).map(([key, value]) => [key, value == null ? "" : String(value)]),
      );
      setResultRows((current) => [...current, result]);
    }
    if (event.type === "file_download" && event.filename && event.base64) {
      const artifact = {
        filename: event.filename,
        base64: event.base64,
        mimeType: event.mimeType || "application/octet-stream",
      };
      setDownloads((current) => [
        ...current.filter((item) => item.filename !== artifact.filename),
        artifact,
      ]);
      downloadBase64File(artifact.filename, artifact.base64, artifact.mimeType);
      setLogs((current) => [...current, `Downloaded ${event.filename}.`]);
    }
    if (event.type === "error") {
      jobFailed.current = true;
      setStatus(event.message || "Eligibility verification failed.");
      setIsRunning(false);
    }
    if (event.type === "cancelled") {
      jobFailed.current = true;
      setStatus("Eligibility verification was cancelled.");
      setIsRunning(false);
    }
    if (event.type === "done") {
      setIsRunning(false);
      if (!jobFailed.current) {
        setHasCompleted(true);
        setStatus("Eligibility verification completed.");
      }
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
    if (!user) return;
    void getCurrentAutomationJob().then((job) => {
      if (!job) return;
      setJobId(job.jobId);
      setLogs(job.logs.map((log) => log.message));
      setProgress({ completed: job.currentCompleted, total: job.totalItems });
      setHasCompleted(job.status === "completed");
      setStatus("Reconnected to the active eligibility run.");
      setIsRunning(job.status === "running");
      if (job.status === "running") connect(job.jobId);
    }).catch(() => {});
  }, [user, connect]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!portal || !inputFile || !credentialFile) return;
    setIsRunning(true);
    setLogs([]);
    setErrorScreenshots([]);
    setDownloads([]);
    setResultRows([]);
    setProgress(null);
    setHasCompleted(false);
    jobFailed.current = false;
    setStatus("Starting eligibility verification...");
    try {
      const formData = new FormData();
      formData.append("workflowId", "eligibility-verification");
      formData.append("portalId", portal.id);
      if (portal.id === "uhc") formData.append("payerId", "uhc-wellmed");
      formData.append("inputFile", inputFile);
      formData.append("credentialFile", credentialFile);
      const nextJobId = await startAutomationJob(formData);
      setJobId(nextJobId);
      connect(nextJobId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to start eligibility verification.");
      setIsRunning(false);
    }
  }

  async function cancel() {
    if (!jobId) return;
    try {
      await cancelAutomationJob(jobId);
      setStatus("Cancellation requested. Finalizing and downloading the partial workbook...");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to cancel.");
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/");
  }

  if (authLoading || !user) {
    return <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.98)_0%,_rgba(240,246,255,0.98)_44%,_rgba(227,238,255,0.95)_100%)]"><LoaderCircle className="h-7 w-7 animate-spin text-blue-600" /></main>;
  }

  const workflowStepIndex = hasCompleted ? 4 : isRunning ? 3 : inputFile && credentialFile ? 2 : credentialFile ? 1 : 0;
  const workflowSteps = ["Upload Login File", "Upload Eligibility File", "Validate Files", "Processing", "Completed"];

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.98)_0%,_rgba(240,246,255,0.98)_44%,_rgba(227,238,255,0.95)_100%)] text-slate-900">
      <nav className="relative z-30 border-b border-sky-100/80 bg-white/80 px-4 py-4 shadow-[0_10px_35px_rgba(148,163,184,0.12)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <button type="button" onClick={() => router.push("/eligibility")} className="flex items-center gap-3 text-left">
            <span className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-[1.15rem] border border-sky-200 bg-white shadow-[0_18px_36px_rgba(37,99,235,0.2)]">
              <Image src="/opus-logo-2.jpg" alt="OPUS logo" fill className="object-contain p-1" />
            </span>
            <span>
              <span className="block text-lg font-semibold tracking-[-0.03em] text-slate-950">Eligibility Verification Portal</span>
              <span className="block text-xs text-slate-500">Multi-payer workspace | Signed in as {user.email || user.username}</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => router.push(portal ? "/eligibility" : "/portal")}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>
      </nav>

      <div className="mx-auto w-full max-w-[96rem] px-3 py-8 sm:px-4 xl:px-5">
        <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="hidden rounded-[2rem] border border-sky-100 bg-white/82 p-4 shadow-[0_18px_60px_rgba(148,163,184,0.14)] backdrop-blur-xl xl:flex xl:min-h-[calc(100vh-10rem)] xl:flex-col 2xl:p-5">
            <div className="flex items-center gap-3 rounded-[1.4rem] bg-[linear-gradient(135deg,rgba(239,246,255,0.98)_0%,rgba(219,234,254,0.82)_100%)] p-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#1473ff_0%,#2563eb_60%,#183db9_100%)] text-white shadow-[0_16px_34px_rgba(37,99,235,0.22)]">
                <Stethoscope className="h-5 w-5" strokeWidth={2.1} />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-950">Eligibility Portal</p>
                <p className="text-xs text-slate-500">Healthcare Automation Platform</p>
              </div>
            </div>
            <div className="mt-6 space-y-1.5">
              <button type="button" onClick={() => router.push("/portal")} className="flex w-full items-center gap-3 rounded-[1rem] bg-[linear-gradient(90deg,rgba(37,99,235,0.12)_0%,rgba(37,99,235,0.04)_100%)] px-3 py-2.5 text-left text-sm font-medium text-blue-700">
                <LayoutDashboard className="h-4 w-4" /> Dashboard
              </button>
              {portal && (
                <button type="button" disabled={isRunning} onClick={() => router.push("/eligibility")} className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400">
                  <Activity className="h-4 w-4" /> Change Portal
                </button>
              )}
              <button type="button" disabled={isRunning} onClick={logout} className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400">
                <LogOut className="h-4 w-4" /> Logout
              </button>
            </div>
          </aside>

          <section className="min-w-0">
            {!portal ? (
              <>
                <div className="rounded-[1.7rem] border border-sky-100 bg-white/88 p-6 shadow-[0_16px_38px_rgba(148,163,184,0.12)]">
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Portal Selection</p>
                  <h1 className="mt-3 text-[1.9rem] font-semibold tracking-[-0.05em] text-slate-950">Eligibility Verification</h1>
                  <p className="mt-2 text-sm text-slate-600">Choose a portal to begin member eligibility verification.</p>
                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    {eligibilityPortals.map((item) => (
                      <button key={item.id} onClick={() => router.push(`/eligibility/${item.id}`)} className="rounded-[1.4rem] border border-sky-100 bg-white p-5 text-left shadow-[0_14px_30px_rgba(148,163,184,0.1)] transition hover:-translate-y-0.5 hover:border-blue-300">
                        <div className="flex items-center justify-between">
                          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-700"><Building2 className="h-5 w-5" /></span>
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[0.65rem] font-semibold text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Ready</span>
                        </div>
                        <h2 className="mt-4 font-semibold text-slate-950">{item.name}</h2>
                        <p className="mt-2 text-sm text-slate-600">{item.description}</p>
                        <span className="mt-4 inline-flex w-full items-center justify-center rounded-[0.9rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-3 py-2.5 text-sm font-medium text-white shadow-[0_14px_26px_rgba(37,99,235,0.22)]">Open Portal &rarr;</span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }} className="relative overflow-hidden rounded-[1.6rem] border border-sky-100 bg-[linear-gradient(135deg,rgba(239,246,255,0.96)_0%,rgba(221,235,255,0.84)_55%,rgba(255,255,255,0.96)_100%)] p-5 shadow-[0_18px_40px_rgba(148,163,184,0.12)]">
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-center">
                    <div className="max-w-xl">
                      <div className="flex items-center gap-3">
                        <span className="flex h-12 w-12 items-center justify-center rounded-[1rem] bg-blue-50 text-sm font-semibold text-blue-700 shadow-inner">{portal.id === "availity" ? "AV" : portal.id === "uhc" ? "UHC" : "WS"}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[0.72rem] font-semibold text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Ready</span>
                      </div>
                      <h1 className="mt-4 text-[1.8rem] font-semibold tracking-[-0.05em] text-slate-950">{heading}</h1>
                      <p className="mt-2 text-sm text-slate-600">{portal.description}</p>
                    </div>
                    <div className="relative hidden h-[12rem] overflow-hidden rounded-[1.2rem] border border-sky-100/80 bg-white/55 shadow-[0_14px_28px_rgba(59,130,246,0.1)] lg:block">
                      <Image src={dashboardWelcomeImage} alt="Healthcare workflow illustration" fill className="scale-[0.92] object-cover object-center" />
                    </div>
                  </div>
                </motion.div>

                <div className="mt-5 rounded-[1.5rem] border border-sky-100 bg-white/88 p-5 shadow-[0_16px_34px_rgba(148,163,184,0.1)]">
                  <div className="flex flex-wrap items-center gap-3 md:flex-nowrap">
                    {workflowSteps.map((step, index) => {
                      const active = index === workflowStepIndex;
                      const complete = index < workflowStepIndex;
                      return <div key={step} className="flex min-w-0 flex-1 items-center gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${complete ? "bg-emerald-100 text-emerald-700" : active ? "bg-[linear-gradient(135deg,#2563eb_0%,#3b82f6_100%)] text-white shadow-[0_12px_24px_rgba(37,99,235,0.24)]" : "bg-sky-50 text-slate-500"}`}>{index + 1}</div>
                        <p className={`truncate text-sm font-medium ${active || complete ? "text-slate-900" : "text-slate-500"}`}>{step}</p>
                        {index < workflowSteps.length - 1 && <div className={`hidden h-px flex-1 md:block ${complete ? "bg-emerald-300" : "bg-sky-100"}`} />}
                      </div>;
                    })}
                  </div>
                </div>

                <div className="mt-5 rounded-[1.7rem] border border-sky-100 bg-white/92 p-5 shadow-[0_16px_38px_rgba(148,163,184,0.12)]">
                  <p className="mb-5 text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Portal Workflow</p>
                  {portal.id === "uhc" ? <UhcInputForm inputFile={inputFile} credentialFile={credentialFile} isRunning={isRunning} canStart={canStart} onInputFileChange={setInputFile} onCredentialFileChange={setCredentialFile} onSubmit={start} onCancel={cancel} /> : portal.id === "availity" ? <AvailityInputForm inputFile={inputFile} credentialFile={credentialFile} isRunning={isRunning} canStart={canStart} onInputFileChange={setInputFile} onCredentialFileChange={setCredentialFile} onSubmit={start} onCancel={cancel} /> : <WaystarInputForm inputFile={inputFile} credentialFile={credentialFile} isRunning={isRunning} canStart={canStart} onInputFileChange={setInputFile} onCredentialFileChange={setCredentialFile} onSubmit={start} onCancel={cancel} />}
                </div>
                <div className="mt-5"><WaystarResultView status={status} logs={logs} errorScreenshots={errorScreenshots} progress={progress} downloads={downloads} resultRows={resultRows} onDownload={downloadBase64File} /></div>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
