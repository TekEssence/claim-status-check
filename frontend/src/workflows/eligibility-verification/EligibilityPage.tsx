"use client";

import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Building2,
  LoaderCircle,
  LogOut,
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
    if (event.type === "log" && event.message) setLogs((current) => [...current, event.message!]);
    if (event.type === "error") {
      setStatus(event.message || "Eligibility verification failed.");
      setIsRunning(false);
    }
    if (event.type === "done" || event.type === "cancelled") setIsRunning(false);
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
        <section className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {breadcrumbs.map((item, index) => (
              <span key={item.href} className="flex items-center gap-2">
                {index > 0 && <span>/</span>}
                <button onClick={() => router.push(item.href)} className="hover:text-blue-700">{item.label}</button>
              </span>
            ))}
          </div>

          <div className="mt-3 flex items-start justify-between gap-4 border-b border-slate-200 pb-5">
            <div>
              <h1 className="text-2xl font-semibold">{heading}</h1>
              <p className="mt-1 text-sm text-slate-600">
                {portal?.description ?? "Choose a portal to begin member eligibility verification."}
              </p>
            </div>
            <button
              onClick={() => router.push(portal ? "/eligibility" : "/portal")}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
                <ArrowLeft className="h-4 w-4" />
                Back
            </button>
          </div>

          {!portal ? (
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {eligibilityPortals.map((item) => (
                <button key={item.id} onClick={() => router.push(`/eligibility/${item.id}`)} className="rounded-md border border-slate-200 bg-white p-5 text-left shadow-sm hover:border-blue-400">
                  <Building2 className="h-6 w-6 text-blue-600" />
                  <h2 className="mt-4 font-semibold">{item.name}</h2>
                  <p className="mt-1 text-sm text-slate-600">{item.description}</p>
                  <p className="mt-4 text-xs font-medium text-slate-500">
                    {item.supportedPayers.join(", ")} detected from the workbook
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
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
              <WaystarResultView status={status} logs={logs} />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
