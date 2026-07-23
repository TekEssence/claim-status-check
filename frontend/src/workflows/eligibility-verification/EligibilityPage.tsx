"use client";

import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ChevronRight,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
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
import type { ScrapeJobEvent } from "../../types/job";
import { WaystarInputForm } from "./portals/waystar/WaystarInputForm";
import { WaystarResultView } from "./portals/waystar/WaystarResultView";

type AuthUser = {
  username: string;
  email: string;
  mustResetPassword: boolean;
};

const workflowSteps = [
  "Upload Credentials",
  "Upload Eligibility File",
  "Validate Files",
  "Processing",
  "Completed",
] as const;

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
  const [isRunning, setIsRunning] = useState(false);
  const streamController = useRef<AbortController | null>(null);

  const heading = portal?.name ?? "Eligibility Verification";
  const canStart = Boolean(portal && inputFile && credentialFile && !isRunning);
  const hasCompletedRun = useMemo(
    () => !isRunning && Boolean(status.trim()) && /(complete|completed|success|finished|done)/i.test(status),
    [isRunning, status],
  );
  const workflowStepIndex = useMemo(() => {
    if (hasCompletedRun) return 4;
    if (isRunning) return 3;
    if (canStart) return 2;
    if (credentialFile || inputFile) return 1;
    return 0;
  }, [canStart, credentialFile, hasCompletedRun, inputFile, isRunning]);

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

  const breadcrumbs = useMemo(() => [
    { label: "Eligibility", href: "/eligibility" },
    ...(portal ? [{ label: portal.name, href: `/eligibility/${portal.id}` }] : []),
  ], [portal]);

  const handleEvent = useCallback((event: ScrapeJobEvent) => {
    if (event.type === "log" && event.message) {
      setLogs((current) => [...current, event.message!]);
    }
    if (event.type === "error") {
      setStatus(event.message || "Eligibility verification failed.");
      setIsRunning(false);
    }
    if (event.type === "done") {
      setStatus(event.message || "Eligibility verification completed.");
      setIsRunning(false);
    }
    if (event.type === "cancelled") {
      setStatus(event.message || "Eligibility verification cancelled.");
      setIsRunning(false);
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
      setStatus("Reconnected to the active eligibility run.");
      setIsRunning(true);
      connect(job.jobId);
    }).catch(() => {});
  }, [user, connect]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!portal || !inputFile || !credentialFile) return;
    setIsRunning(true);
    setLogs([]);
    setStatus("Starting eligibility verification...");
    try {
      const formData = new FormData();
      formData.append("workflowId", "eligibility-verification");
      formData.append("portalId", portal.id);
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
    await cancelAutomationJob(jobId).catch((error) => {
      setStatus(error instanceof Error ? error.message : "Unable to cancel.");
    });
    setIsRunning(false);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/");
  }

  if (authLoading || !user) {
    return <main className="flex min-h-screen items-center justify-center"><LoaderCircle className="h-7 w-7 animate-spin text-blue-600" /></main>;
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.98)_0%,_rgba(240,246,255,0.98)_44%,_rgba(227,238,255,0.95)_100%)] text-slate-900">
      <header className="border-b border-sky-100/80 bg-white/80 px-4 py-4 shadow-[0_10px_35px_rgba(148,163,184,0.12)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <button onClick={() => router.push("/portal")} className="flex items-center gap-3 text-left">
            <span className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-[1.15rem] border border-sky-200 bg-white shadow-[0_18px_36px_rgba(37,99,235,0.2)]">
              <Image src="/opus-logo-2.jpg" alt="OPUS" fill className="object-contain p-1" />
            </span>
            <span>
              <span className="block text-lg font-semibold tracking-[-0.03em] text-slate-950">Eligibility Verification</span>
              <span className="block text-xs text-slate-500">Automation workspace | Signed in as {user.email || user.username}</span>
            </span>
          </button>
          <button onClick={logout} title="Logout" className="rounded-[0.95rem] border border-sky-100 bg-white p-2.5 text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-900">
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="rounded-[2rem] border border-sky-100 bg-white/86 p-6 shadow-[0_24px_80px_rgba(148,163,184,0.16)] backdrop-blur-xl md:p-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              {breadcrumbs.map((item, index) => (
                <span key={item.href} className="flex items-center gap-2">
                  {index > 0 && <ChevronRight className="h-3.5 w-3.5" />}
                  <button onClick={() => router.push(item.href)} className="hover:text-blue-700">{item.label}</button>
                </span>
              ))}
            </div>
            <button
              onClick={() => router.push(portal ? "/eligibility" : "/portal")}
              className="inline-flex items-center gap-2 rounded-[0.95rem] border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          </div>

          {!portal ? (
            <>
              <section className="relative mt-6 overflow-hidden rounded-[1.7rem] border border-sky-100 bg-[linear-gradient(135deg,rgba(239,246,255,0.96)_0%,rgba(221,235,255,0.82)_50%,rgba(255,255,255,0.94)_100%)] px-6 py-7 shadow-[0_18px_44px_rgba(148,163,184,0.12)]">
                <div className="max-w-[32rem]">
                  <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-sky-700 shadow-sm">
                    <Sparkles className="h-3.5 w-3.5" />
                    Eligibility workflow hub
                  </span>
                  <h1 className="mt-4 text-[2rem] font-semibold tracking-[-0.05em] text-slate-950">Choose a portal for member eligibility checks</h1>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    Open a portal workspace, upload the workbook files, and monitor the verification run from a cleaner dashboard-style flow.
                  </p>
                </div>
                <div className="pointer-events-none absolute -right-8 -top-10 h-44 w-44 rounded-full bg-blue-200/40 blur-3xl" />
                <div className="pointer-events-none absolute bottom-0 right-10 h-28 w-28 rounded-full bg-sky-100/80 blur-2xl" />
              </section>

              <div className="mt-6 grid gap-5 md:grid-cols-2">
                {eligibilityPortals.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => router.push(`/eligibility/${item.id}`)}
                    className="rounded-[1.5rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(244,249,255,0.96)_100%)] p-5 text-left shadow-[0_14px_28px_rgba(148,163,184,0.1)] transition duration-200 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-[0_18px_36px_rgba(59,130,246,0.12)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-[1rem] bg-[linear-gradient(180deg,#dbeafe_0%,#bfdbfe_100%)] text-blue-700 shadow-inner">
                        <Building2 className="h-5 w-5" strokeWidth={2.1} />
                      </div>
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[0.68rem] font-semibold text-emerald-600">
                        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.4} />
                        Ready
                      </span>
                    </div>
                    <h2 className="mt-4 text-lg font-semibold tracking-[-0.03em] text-slate-950">{item.name}</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{item.description}</p>
                    <div className="mt-4 rounded-[1rem] border border-sky-100 bg-white/80 px-3 py-3">
                      <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-slate-500">Supported payers</p>
                      <p className="mt-1 text-sm font-medium text-slate-800">{item.supportedPayers.join(", ")}</p>
                    </div>
                    <span className="mt-4 inline-flex items-center gap-2 rounded-[0.95rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-4 py-2.5 text-sm font-medium text-white shadow-[0_14px_26px_rgba(37,99,235,0.22)]">
                      Open Portal
                      <ChevronRight className="h-4 w-4" />
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <section className="relative mt-6 overflow-hidden rounded-[1.6rem] border border-sky-100 bg-[linear-gradient(135deg,rgba(239,246,255,0.96)_0%,rgba(221,235,255,0.84)_55%,rgba(255,255,255,0.96)_100%)] p-5 shadow-[0_18px_40px_rgba(148,163,184,0.12)]">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-center">
                  <div className="max-w-xl">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="flex h-12 w-12 items-center justify-center rounded-[1rem] bg-[linear-gradient(135deg,#2563eb_0%,#3b82f6_100%)] text-white shadow-[0_12px_24px_rgba(37,99,235,0.24)]">
                        <ShieldCheck className="h-5 w-5" strokeWidth={2.2} />
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[0.72rem] font-semibold text-emerald-600">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Ready
                      </span>
                    </div>
                    <h1 className="mt-4 text-[1.8rem] font-semibold tracking-[-0.05em] text-slate-950">{heading}</h1>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {portal.description}
                    </p>
                  </div>

                  <div className="hidden rounded-[1.2rem] border border-sky-100/80 bg-white/70 p-5 shadow-[0_14px_28px_rgba(59,130,246,0.1)] lg:block">
                    <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-sky-600">Routing</p>
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      Workbook rows are matched automatically using payer name fields, so the team can start the run with fewer manual setup steps.
                    </p>
                  </div>
                </div>
              </section>

              <div className="mt-5 rounded-[1.5rem] border border-sky-100 bg-white/88 p-5 shadow-[0_16px_34px_rgba(148,163,184,0.1)]">
                <div className="flex flex-wrap items-center gap-3 md:flex-nowrap">
                  {workflowSteps.map((step, index) => {
                    const isActive = index === workflowStepIndex;
                    const isComplete = index < workflowStepIndex;

                    return (
                      <div key={step} className="flex min-w-0 flex-1 items-center gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                          isComplete
                            ? "bg-emerald-100 text-emerald-700"
                            : isActive
                              ? "bg-[linear-gradient(135deg,#2563eb_0%,#3b82f6_100%)] text-white shadow-[0_12px_24px_rgba(37,99,235,0.24)]"
                              : "bg-sky-50 text-slate-500"
                        }`}>
                          {index + 1}
                        </div>
                        <div className="min-w-0">
                          <p className={`truncate text-sm font-medium ${isActive || isComplete ? "text-slate-900" : "text-slate-500"}`}>{step}</p>
                        </div>
                        {index < workflowSteps.length - 1 ? (
                          <div className={`hidden h-px flex-1 md:block ${isComplete ? "bg-emerald-300" : "bg-sky-100"}`} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-5 rounded-[1.7rem] border border-sky-100 bg-white/92 p-5 shadow-[0_16px_38px_rgba(148,163,184,0.12)]">
                <div className="mb-5">
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Portal Workflow</p>
                </div>
                <WaystarInputForm
                  inputFile={inputFile}
                  credentialFile={credentialFile}
                  isRunning={isRunning}
                  canStart={canStart}
                  onInputFileChange={setInputFile}
                  onCredentialFileChange={setCredentialFile}
                  onSubmit={start}
                  onCancel={cancel}
                />
              </div>

              <div className="mt-5">
                <WaystarResultView status={status} logs={logs} />
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
