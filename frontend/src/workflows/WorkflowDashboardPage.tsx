"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Ban,
  FileSearch,
  HeartPulse,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  ReceiptText,
  BadgeDollarSign,
  ShieldEllipsis,
  Stethoscope,
  Users,
} from "lucide-react";
import { getCognitoAccessToken, getCognitoUserProfile, isCognitoMode, redirectToCognitoLogout } from "../api/cognito-auth";
import { cancelScrapeJob, forceStopScrapeJob, listScrapeJobs, type ScrapeJobSummary } from "../api/scrape-jobs-api";

type AuthUser = {
  username: string;
  email: string;
  role: "ADMIN" | "DEVELOPER" | "USER";
  mustResetPassword: boolean;
};

const AUTH_USER_STORAGE_KEY = "claim-status-auth-user";

function hasFullWorkflowAccess(user: AuthUser | null): boolean {
  return user?.role === "ADMIN" || user?.role === "DEVELOPER";
}

function formatDisplayName(user: AuthUser | null): string {
  const raw = user?.email || user?.username || "";
  const localPart = raw.includes("@") ? raw.split("@")[0] : raw;
  const firstName = localPart.split(/[._\-\s]+/).find(Boolean) || localPart;
  if (!firstName) return "User";
  return firstName[0].toUpperCase() + firstName.slice(1).toLowerCase();
}

function formatWorkflowLabel(workflowId: string): string {
  if (workflowId === "claim-status") return "Claim Status";
  if (workflowId === "eligibility-verification") return "Eligibility";
  if (workflowId === "payment-eob-download") return "Payment EOB";
  if (workflowId === "payment-posting") return "Payment Posting";
  return workflowId.replace(/-/g, " ");
}

function formatShortJobId(jobId: string): string {
  return jobId.slice(0, 8);
}

function formatRunTimestamp(value?: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatUploadedJobFiles(job: ScrapeJobSummary): string {
  const files = [job.loginFileName, job.claimFileName]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return files.length > 0 ? files.join(", ") : "Uploaded files";
}

function isLiveWorkflowStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting_otp" || status === "waiting_resume" || status === "cancelling";
}

const workflows = [
  {
    id: "claim-status",
    name: "Claim Status",
    description: "Verify claim status across IEHP, Aerial, Regal, Blue Shield, and Availity.",
    route: "/claim-status",
    icon: FileSearch,
    iconClassName: "bg-blue-100 text-blue-700",
  },
  {
    id: "eligibility-verification",
    name: "Eligibility Verification",
    description: "Verify member eligibility through Waystar and future eligibility portals.",
    route: "/eligibility",
    icon: HeartPulse,
    iconClassName: "bg-emerald-100 text-emerald-700",
  },
  {
    id: "payment-eob-download",
    name: "Payment EOB Download",
    description: "Prepare remittance comparison and EOB download automation for payment portals.",
    route: "/payment-eob-download",
    icon: ReceiptText,
    iconClassName: "bg-amber-100 text-amber-700",
  },
  {
    id: "payment-posting",
    name: "Payment Posting",
    description: "Validate payment posting input and prepare dry-run portal workflows without posting payments.",
    route: "/payment-posting",
    icon: BadgeDollarSign,
    iconClassName: "bg-emerald-100 text-emerald-700",
  },
] as const;

export function WorkflowDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [operationsJobs, setOperationsJobs] = useState<ScrapeJobSummary[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [operationsError, setOperationsError] = useState("");
  const [stoppingJobId, setStoppingJobId] = useState("");
  const displayName = formatDisplayName(user);

  useEffect(() => {
    if (isCognitoMode()) {
      if (!getCognitoAccessToken()) {
        router.replace("/");
        return;
      }
      const profile = getCognitoUserProfile();
      setUser({
        username: profile?.username || "Cognito user",
        email: profile?.email || "Signed in with Cognito",
        role: profile?.role || "USER",
        mustResetPassword: false,
      });
      setLoading(false);
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
          router.replace("/claim-status");
          return;
        }
        setUser(nextUser);
      })
      .catch(() => router.replace("/"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [router]);

  async function logout() {
    if (isCognitoMode()) {
      redirectToCognitoLogout();
      return;
    }

    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    try {
      window.sessionStorage.removeItem(AUTH_USER_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
    router.replace("/");
  }

  function openWorkflow(route: string) {
    try {
      window.sessionStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user));
    } catch {
      // Ignore storage failures.
    }
    router.push(route);
  }

  async function refreshOperationsJobs(options?: { silent?: boolean }) {
    if (!hasFullWorkflowAccess(user)) {
      setOperationsJobs([]);
      setOperationsError("");
      return;
    }

    if (!options?.silent) {
      setOperationsLoading(true);
      setOperationsError("");
    }

    try {
      const jobs = await listScrapeJobs(50, { scope: "all-running" });
      setOperationsJobs(jobs.filter((job) => isLiveWorkflowStatus(job.status)));
    } catch (error) {
      setOperationsError(error instanceof Error ? error.message : "Failed to load running tasks.");
    } finally {
      if (!options?.silent) setOperationsLoading(false);
    }
  }

  async function cancelRun(job: ScrapeJobSummary) {
    setStoppingJobId(job.jobId);
    try {
      await cancelScrapeJob(job.jobId);
      await refreshOperationsJobs({ silent: true });
    } catch (error) {
      setOperationsError(error instanceof Error ? error.message : "Failed to cancel task.");
    } finally {
      setStoppingJobId("");
    }
  }

  async function forceStopRun(job: ScrapeJobSummary) {
    setStoppingJobId(job.jobId);
    try {
      await forceStopScrapeJob(job.jobId);
      await refreshOperationsJobs({ silent: true });
    } catch (error) {
      setOperationsError(error instanceof Error ? error.message : "Failed to force stop task.");
    } finally {
      setStoppingJobId("");
    }
  }

  useEffect(() => {
    if (!hasFullWorkflowAccess(user)) return;
    let cancelled = false;
    const load = async (silent: boolean) => {
      if (cancelled) return;
      await refreshOperationsJobs({ silent });
    };
    void load(false);
    const interval = window.setInterval(() => void load(true), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [user?.email, user?.role]);

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f4f7fb]">
        <LoaderCircle className="h-7 w-7 animate-spin text-blue-600" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f4f7fb] text-slate-900">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="relative h-11 w-11 overflow-hidden rounded-md border border-slate-200">
              <Image src="/opus-logo-2.jpg" alt="OPUS" fill sizes="44px" className="object-contain p-1" />
            </span>
            <span>
              <span className="block text-sm font-semibold">Healthcare Automation</span>
              <span className="block text-xs text-slate-500">{displayName}</span>
            </span>
          </div>
          <button
            type="button"
            onClick={logout}
            title="Logout"
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="hidden min-h-[calc(100vh-8rem)] flex-col border-r border-slate-200 pr-5 lg:flex">
          <div className="flex items-center gap-3 rounded-md bg-blue-50 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-600 text-white">
              <Stethoscope className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold">Automation Portal</span>
              <span className="block text-xs text-slate-500">Healthcare workflows</span>
            </span>
          </div>

          <nav className="mt-6 space-y-1">
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-md bg-blue-50 px-3 py-2.5 text-left text-sm font-semibold text-blue-700"
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => router.push("/claim-status?view=reset-password")}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-slate-600 hover:bg-white hover:text-slate-900"
            >
              <ShieldEllipsis className="h-4 w-4" />
              Reset Password
            </button>
            {hasFullWorkflowAccess(user) && (
              <button
                type="button"
                onClick={() => router.push("/claim-status?view=manage-users")}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-slate-600 hover:bg-white hover:text-slate-900"
              >
                <Users className="h-4 w-4" />
                Manage Users
              </button>
            )}
            <button
              type="button"
              onClick={logout}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-slate-600 hover:bg-white hover:text-slate-900"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </nav>
        </aside>

        <section className="min-w-0">
          <div className="border-b border-slate-200 pb-6">
            <p className="text-xs font-semibold uppercase text-blue-600">Dashboard</p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-950">Choose a workflow</h1>
            <p className="mt-2 text-sm text-slate-600">Select the healthcare automation you want to run.</p>
          </div>

          {hasFullWorkflowAccess(user) && (
            <div className="mt-7 rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-100 pb-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Operations</p>
                  <h2 className="mt-1 text-lg font-semibold text-slate-950">All running tasks</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    {operationsJobs.length} active {operationsJobs.length === 1 ? "task" : "tasks"} across users.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void refreshOperationsJobs()}
                  className="rounded-xl border border-indigo-100 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-indigo-50"
                >
                  {operationsLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              {operationsError ? (
                <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {operationsError}
                </div>
              ) : operationsJobs.length === 0 ? (
                <div className="mt-4 rounded-xl border border-dashed border-indigo-200 bg-indigo-50/60 px-4 py-6 text-center text-sm text-slate-500">
                  No running tasks found.
                </div>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-indigo-100 bg-indigo-50/60 text-xs uppercase tracking-[0.12em] text-slate-500">
                        <th className="whitespace-nowrap px-3 py-3 font-semibold">Run</th>
                        <th className="whitespace-nowrap px-3 py-3 font-semibold">User</th>
                        <th className="whitespace-nowrap px-3 py-3 font-semibold">Workflow</th>
                        <th className="min-w-[14rem] px-3 py-3 font-semibold">Uploaded File</th>
                        <th className="whitespace-nowrap px-3 py-3 font-semibold">Status</th>
                        <th className="whitespace-nowrap px-3 py-3 font-semibold">Created</th>
                        <th className="whitespace-nowrap px-3 py-3 text-right font-semibold">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {operationsJobs.map((job) => (
                        <tr key={job.jobId} className="border-b border-indigo-50 last:border-0 hover:bg-indigo-50/40">
                          <td className="whitespace-nowrap px-3 py-3 font-mono text-xs font-semibold text-blue-700">
                            {formatShortJobId(job.jobId)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                            {job.createdByName && job.createdByName !== "unknown" ? job.createdByName : job.createdByEmail || job.userId || "unknown"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 text-slate-700">{formatWorkflowLabel(job.workflowId || "claim-status")}</td>
                          <td className="px-3 py-3">
                            <div className="max-w-[18rem] truncate text-xs text-slate-500" title={formatUploadedJobFiles(job)}>
                              {formatUploadedJobFiles(job)}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3">
                            <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                              {job.status.replace(/_/g, " ")}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.createdAt)}</td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => void cancelRun(job)}
                                disabled={stoppingJobId === job.jobId}
                                className="rounded-lg border border-red-100 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-300"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => void forceStopRun(job)}
                                disabled={stoppingJobId === job.jobId}
                                className="rounded-lg border border-amber-100 bg-white px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:cursor-not-allowed disabled:text-slate-300"
                              >
                                <span className="inline-flex items-center gap-1">
                                  <Ban className="h-3.5 w-3.5" />
                                  Force Stop
                                </span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="mt-7 grid gap-5 md:grid-cols-2">
            {workflows.map((workflow) => {
              const Icon = workflow.icon;
              return (
                <button
                  key={workflow.id}
                  type="button"
                  onClick={() => openWorkflow(workflow.route)}
                  className="group flex min-h-52 flex-col border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:border-blue-400 hover:shadow-md"
                >
                  <span className={`flex h-11 w-11 items-center justify-center rounded-md ${workflow.iconClassName}`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <h2 className="mt-5 text-xl font-semibold">{workflow.name}</h2>
                  <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{workflow.description}</p>
                  <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-blue-700">
                    Open workflow
                    <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
