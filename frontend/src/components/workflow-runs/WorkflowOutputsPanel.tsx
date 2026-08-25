"use client";

import { Download, FileSpreadsheet, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getScrapeJobDownload } from "../../api/scrape-jobs-api";
import { listAutomationJobs, type AutomationJobSummary } from "../../api/automation-jobs-api";

type WorkflowOutputsPanelProps = {
  workflowId: string;
  title: string;
};

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function startDownload(downloadUrl: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = filename;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function WorkflowOutputsPanel({ workflowId, title }: WorkflowOutputsPanelProps) {
  const [jobs, setJobs] = useState<AutomationJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadingJobId, setDownloadingJobId] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const runs = await listAutomationJobs(100);
      setJobs(runs.filter((job) => job.workflowId === workflowId && job.artifactCount > 0));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Unable to load outputs.");
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function download(job: AutomationJobSummary) {
    setDownloadingJobId(job.jobId);
    setError("");
    try {
      const output = await getScrapeJobDownload(job.jobId);
      startDownload(output.downloadUrl, output.filename);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Unable to download output.");
    } finally {
      setDownloadingJobId("");
    }
  }

  return (
    <section className="mt-5 rounded-[1.5rem] border border-emerald-100 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-emerald-600">Outputs</p>
          <h2 className="mt-1 text-xl font-semibold text-slate-950">{title}</h2>
          <p className="mt-1 text-sm text-slate-600">Completed, cancelled, and partial outputs saved in AWS.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 px-3 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>
      {error ? <p className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
      {!loading && jobs.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-emerald-200 bg-emerald-50/50 px-4 py-8 text-center text-sm text-slate-500">No output files are available yet.</p> : null}
      {jobs.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead><tr className="border-b border-emerald-100 text-xs uppercase tracking-wider text-slate-400"><th className="px-3 py-3">Output</th><th className="px-3 py-3">Portal</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Finished</th><th className="px-3 py-3 text-right">Action</th></tr></thead>
            <tbody>{jobs.map((job) => (
              <tr key={job.jobId} className="border-b border-emerald-50 last:border-0">
                <td className="px-3 py-3"><span className="inline-flex items-center gap-2 font-medium text-slate-800"><FileSpreadsheet className="h-4 w-4 text-emerald-600" />{job.primaryInputFileName || "Output file"}</span></td>
                <td className="px-3 py-3 text-slate-600">{job.portalId}</td>
                <td className="px-3 py-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold capitalize text-slate-700">{job.status.replaceAll("_", " ")}</span></td>
                <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatTimestamp(job.finishedAt || job.updatedAt)}</td>
                <td className="px-3 py-3 text-right"><button type="button" onClick={() => void download(job)} disabled={downloadingJobId === job.jobId} className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"><Download className="h-4 w-4" />{downloadingJobId === job.jobId ? "Preparing" : "Download"}</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
