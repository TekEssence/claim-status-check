"use client";

import { useEffect, useMemo, useState } from "react";
import { listScrapeJobs, type ScrapeJobSummary } from "../../api/scrape-jobs-api";

type WorkflowRun = {
  jobId: string;
  workflowId: string;
  portalId: string;
  status: string;
  completed: number;
  total: number;
  fileNames: string[];
  createdAt: string;
  updatedAt: string;
};

const PORTAL_LABELS: Record<string, string> = {
  aerial: "Aerial",
  "all-care": "All Care",
  astrona: "Astrona",
  availity: "Availity",
  "availity-remittance": "Availity Remittance",
  "blue-shield": "Blue Shield",
  cigna: "Cigna",
  advancedmd: "AdvancedMD",
  iehp: "IEHP",
  "instamed-remittance": "InstaMed Remittance",
  kaiser: "Kaiser",
  "my-family": "My Family",
  "optum-pro": "Optum Pro",
  physicians: "Physicians",
  regal: "Regal",
  uhc: "UHC",
  waystar: "Waystar",
  zelis: "Zelis",
};

const WORKFLOW_LABELS: Record<string, string> = {
  "claim-status": "Claim Status",
  "eligibility-verification": "Eligibility",
  "payment-eob-download": "Payment EOB",
  "payment-posting": "Payment Posting",
};

function isLiveStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting_otp";
}

function formatShortJobId(jobId: string): string {
  return jobId.slice(0, 8);
}

function formatRunTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function uploadedFiles(...names: Array<string | null | undefined>): string[] {
  return names.map((name) => String(name || "").trim()).filter(Boolean);
}

function formatUploadedFiles(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "Uploaded files";
}

function normalizeClaimJob(job: ScrapeJobSummary): WorkflowRun {
  return {
    jobId: job.jobId,
    workflowId: job.workflowId || "claim-status",
    portalId: job.portalId,
    status: job.status,
    completed: job.currentCompleted,
    total: job.totalRows,
    fileNames: uploadedFiles(job.loginFileName, job.claimFileName),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function ActiveWorkflowRunsPanel({
  currentWorkflowId,
  currentPortalId,
}: {
  currentWorkflowId?: string;
  currentPortalId?: string;
}) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function refresh(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setLoading(true);
      setError("");
    }

    try {
      const claimJobs = await listScrapeJobs(50).catch(() => [] as ScrapeJobSummary[]);

      setRuns(
        claimJobs
          .map(normalizeClaimJob)
          .filter((job) => isLiveStatus(job.status))
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load active runs.");
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const load = async (silent: boolean) => {
      if (!cancelled) await refresh({ silent });
    };
    void load(false);
    const timer = window.setInterval(() => void load(true), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const visibleRuns = useMemo(() => runs, [runs]);
  const currentScopeLabel = currentWorkflowId || currentPortalId ? " across your account" : "";

  return (
    <section className="mt-5 rounded-[1.5rem] border border-sky-100 bg-white/92 p-5 shadow-[0_16px_36px_rgba(148,163,184,0.12)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Active Runs</p>
          <h2 className="mt-1 text-base font-semibold text-slate-950">Current automation progress</h2>
          <p className="mt-1 text-xs text-slate-500">
            {visibleRuns.length} active {visibleRuns.length === 1 ? "run" : "runs"}{currentScopeLabel}.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-10 items-center justify-center rounded-[0.95rem] border border-sky-100 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-sky-50"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="rounded-[1rem] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load active runs: {error}
        </div>
      ) : visibleRuns.length === 0 ? (
        <div className="rounded-[1rem] border border-dashed border-sky-200 bg-sky-50/60 px-4 py-5 text-center text-sm text-slate-500">
          No active runs found.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-sky-100 text-xs uppercase tracking-[0.14em] text-slate-400">
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Run</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Workflow</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Portal</th>
                <th className="min-w-[14rem] px-3 py-3 font-semibold">Uploaded File</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Status</th>
                <th className="min-w-[12rem] px-3 py-3 font-semibold">Progress</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Created</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {visibleRuns.map((run) => {
                const percent = run.total > 0 ? Math.min(100, Math.round((run.completed / run.total) * 100)) : 0;
                return (
                  <tr key={run.jobId} className="border-b border-sky-50 last:border-0">
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className="font-mono text-xs font-semibold text-blue-700">{formatShortJobId(run.jobId)}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{WORKFLOW_LABELS[run.workflowId] ?? run.workflowId}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{PORTAL_LABELS[run.portalId] ?? run.portalId.toUpperCase()}</td>
                    <td className="px-3 py-3">
                      <div className="max-w-[18rem] truncate text-xs text-slate-500" title={formatUploadedFiles(run.fileNames)}>
                        {formatUploadedFiles(run.fileNames)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                        {run.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span>{run.total > 0 ? `${run.completed} of ${run.total} rows` : "Rows not reported"}</span>
                        <span>{percent}%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-sky-50">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${percent}%` }} />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(run.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(run.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
