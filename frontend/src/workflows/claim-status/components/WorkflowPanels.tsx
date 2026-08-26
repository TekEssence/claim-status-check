import { Download, FileSpreadsheet } from "lucide-react";
import type { ScrapeJobSummary } from "../../../api/scrape-jobs-api";
import { claimStatusPortalRegistry } from "../registry";
import {
  formatRunTimestamp, formatShortJobId, formatUploadedJobFiles,
  formatWorkflowLabel, hasExcelOutput, isExcelOutputArtifact, isLiveWorkflowStatus,
} from "../shared/model";

type JobAction = (job: ScrapeJobSummary) => void | Promise<void>;

export function WorkflowRunsPanel({
  enabled, runningCount, jobs, loading, error, selectedJobId,
  downloadingJobId, cancellingJobId, onRefresh, onSelect, onDownload, onCancel,
}: {
  enabled: boolean; runningCount: number; jobs: ScrapeJobSummary[]; loading: boolean;
  error: string; selectedJobId: string; downloadingJobId: string; cancellingJobId: string;
  onRefresh: () => void | Promise<void>; onSelect: JobAction; onDownload: JobAction; onCancel: JobAction;
}) {
  if (!enabled) return null;
  const runningWorkflowRunCount = runningCount;
  const visibleWorkflowRuns = jobs;
  const workflowRunsLoading = loading;
  const workflowRunsError = error;
  const selectedWorkflowRunId = selectedJobId;
  const downloadingWorkflowJobId = downloadingJobId;
  const cancellingWorkflowJobId = cancellingJobId;
  const refreshWorkflowRuns = onRefresh;
  const selectWorkflowRun = onSelect;
  const downloadWorkflowRun = onDownload;
  const cancelWorkflowRun = onCancel;
  return <div className="mt-5 rounded-[1.5rem] border border-sky-200 bg-gradient-to-br from-white via-white to-sky-50/70 p-5 shadow-[0_18px_42px_rgba(14,116,144,0.10)] ring-1 ring-sky-100/70">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">My Active Runs</p>
          <h2 className="mt-1 text-base font-semibold text-slate-950">Current automation progress</h2>
          <p className="mt-1 text-xs text-slate-500">
            {runningWorkflowRunCount} active {runningWorkflowRunCount === 1 ? "run" : "runs"} across your account.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshWorkflowRuns()}
          className="inline-flex h-10 items-center justify-center rounded-[0.95rem] border border-sky-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-sky-50"
        >
          {workflowRunsLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {workflowRunsError ? (
        <div className="rounded-[1rem] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load runs: {workflowRunsError}
        </div>
      ) : visibleWorkflowRuns.length === 0 ? (
        <div className="rounded-[1rem] border border-dashed border-sky-300 bg-sky-50/80 px-4 py-6 text-center text-sm text-slate-500">
          No active runs found for this view.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-sky-200 bg-sky-50/70 text-xs uppercase tracking-[0.14em] text-slate-500">
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Run</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Workflow</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Portal</th>
                <th className="min-w-[14rem] px-3 py-3 font-semibold">Uploaded File</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Status</th>
                <th className="min-w-[12rem] px-3 py-3 font-semibold">Progress</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Created</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Updated</th>
                <th className="whitespace-nowrap px-3 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleWorkflowRuns.map((job) => {
                const portalName = claimStatusPortalRegistry.find((portal) => portal.id === job.portalId)?.name ?? job.portalId.toUpperCase();
                const progressPercent = job.totalRows > 0
                  ? Math.min(100, Math.round((job.currentCompleted / job.totalRows) * 100))
                  : 0;
                const isActiveStatus = isLiveWorkflowStatus(job.status);
                const hasOutput = hasExcelOutput(job);
                const statusClassName =
                  job.status === "completed"
                    ? "bg-emerald-50 text-emerald-700"
                    : job.status === "failed"
                      ? "bg-red-50 text-red-700"
                      : job.status === "cancelled"
                        ? "bg-slate-100 text-slate-600"
                        : job.status === "waiting_otp"
                          ? "bg-amber-50 text-amber-700"
                          : "bg-blue-50 text-blue-700";

                return (
                  <tr
                    key={job.jobId}
                    className={`border-b border-sky-100 last:border-0 ${selectedWorkflowRunId === job.jobId ? "bg-blue-50/65" : "hover:bg-sky-50/45"}`}
                  >
                    <td className="whitespace-nowrap px-3 py-3">
                      <button
                        type="button"
                        onClick={() => void selectWorkflowRun(job)}
                        className="font-mono text-xs font-semibold text-blue-700 hover:text-blue-900"
                      >
                        {formatShortJobId(job.jobId)}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{formatWorkflowLabel(job.workflowId)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{portalName}</td>
                    <td className="px-3 py-3">
                      <div className="max-w-[18rem] truncate text-xs text-slate-500" title={formatUploadedJobFiles(job)}>
                        {formatUploadedJobFiles(job)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClassName}`}>
                        {job.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span>{job.totalRows > 0 ? `${job.currentCompleted} of ${job.totalRows} rows` : "Rows not reported"}</span>
                        <span>{progressPercent}%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-sky-50">
                        <div
                          className={`h-full rounded-full ${job.status === "failed" ? "bg-red-400" : job.status === "completed" ? "bg-emerald-500" : "bg-blue-500"}`}
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.updatedAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void selectWorkflowRun(job)}
                          className="rounded-[0.75rem] border border-sky-100 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-sky-50"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => void downloadWorkflowRun(job)}
                          disabled={!hasOutput || downloadingWorkflowJobId === job.jobId}
                          title={hasOutput ? "Download the latest partial output workbook" : "No partial output workbook has been saved yet"}
                          className="rounded-[0.75rem] border border-emerald-100 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          {downloadingWorkflowJobId === job.jobId ? "Preparing" : hasOutput ? "Partial" : "No partial"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancelWorkflowRun(job)}
                          disabled={!isActiveStatus || cancellingWorkflowJobId === job.jobId}
                          className="rounded-[0.75rem] border border-red-100 bg-white px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          {cancellingWorkflowJobId === job.jobId ? "Cancelling" : "Cancel"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  ;
}

export function OperationsRunningJobsPanel({
  enabled, jobs, loading, error, selectedJobId, cancellingJobId, forceStoppingJobId,
  onRefresh, onSelect, onCancel, onForceStop,
}: {
  enabled: boolean; jobs: ScrapeJobSummary[]; loading: boolean; error: string;
  selectedJobId: string; cancellingJobId: string; forceStoppingJobId: string;
  onRefresh: () => void | Promise<void>; onSelect: JobAction; onCancel: JobAction; onForceStop: JobAction;
}) {
  if (!enabled) return null;
  const operationsRunningJobs = jobs;
  const operationsRunningJobsLoading = loading;
  const operationsRunningJobsError = error;
  const selectedWorkflowRunId = selectedJobId;
  const cancellingWorkflowJobId = cancellingJobId;
  const forceStoppingWorkflowJobId = forceStoppingJobId;
  const refreshOperationsRunningJobs = onRefresh;
  const selectWorkflowRun = onSelect;
  const cancelWorkflowRun = onCancel;
  const forceStopWorkflowRun = onForceStop;
  return <div className="mt-5 rounded-[1.5rem] border border-indigo-100 bg-white/92 p-5 shadow-[0_16px_36px_rgba(148,163,184,0.12)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-indigo-600">Operations</p>
          <h2 className="mt-1 text-base font-semibold text-slate-950">All running tasks</h2>
          <p className="mt-1 text-xs text-slate-500">
            {operationsRunningJobs.length} active {operationsRunningJobs.length === 1 ? "task" : "tasks"} across users.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshOperationsRunningJobs()}
          className="inline-flex h-10 items-center justify-center rounded-[0.95rem] border border-indigo-100 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-indigo-50"
        >
          {operationsRunningJobsLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {operationsRunningJobsError ? (
        <div className="rounded-[1rem] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load running tasks: {operationsRunningJobsError}
        </div>
      ) : operationsRunningJobs.length === 0 ? (
        <div className="rounded-[1rem] border border-dashed border-indigo-200 bg-indigo-50/60 px-4 py-6 text-center text-sm text-slate-500">
          No running tasks found.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-indigo-100 text-xs uppercase tracking-[0.14em] text-slate-400">
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Run</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">User</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Workflow</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Portal</th>
                <th className="min-w-[14rem] px-3 py-3 font-semibold">Uploaded File</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Status</th>
                <th className="min-w-[12rem] px-3 py-3 font-semibold">Progress</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Created</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Updated</th>
                <th className="whitespace-nowrap px-3 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {operationsRunningJobs.map((job) => {
                const portalName = claimStatusPortalRegistry.find((portal) => portal.id === job.portalId)?.name ?? job.portalId.toUpperCase();
                const progressPercent = job.totalRows > 0
                  ? Math.min(100, Math.round((job.currentCompleted / job.totalRows) * 100))
                  : 0;
                const isActiveStatus = isLiveWorkflowStatus(job.status);

                return (
                  <tr
                    key={job.jobId}
                    className={`border-b border-indigo-50 last:border-0 ${selectedWorkflowRunId === job.jobId ? "bg-indigo-50/45" : ""}`}
                  >
                    <td className="whitespace-nowrap px-3 py-3">
                      <button
                        type="button"
                        onClick={() => void selectWorkflowRun(job)}
                        className="font-mono text-xs font-semibold text-blue-700 hover:text-blue-900"
                      >
                        {formatShortJobId(job.jobId)}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <div className="max-w-[12rem] truncate text-xs text-slate-600" title={job.createdByEmail || job.userId || "unknown"}>
                        {job.createdByName && job.createdByName !== "unknown" ? job.createdByName : job.createdByEmail || job.userId || "unknown"}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{formatWorkflowLabel(job.workflowId)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{portalName}</td>
                    <td className="px-3 py-3">
                      <div className="max-w-[18rem] truncate text-xs text-slate-500" title={formatUploadedJobFiles(job)}>
                        {formatUploadedJobFiles(job)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                        {job.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span>{job.totalRows > 0 ? `${job.currentCompleted} of ${job.totalRows} rows` : "Rows not reported"}</span>
                        <span>{progressPercent}%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-indigo-50">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${progressPercent}%` }} />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.updatedAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void selectWorkflowRun(job)}
                          className="rounded-[0.75rem] border border-indigo-100 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-indigo-50"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancelWorkflowRun(job)}
                          disabled={!isActiveStatus || cancellingWorkflowJobId === job.jobId}
                          className="rounded-[0.75rem] border border-red-100 bg-white px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          {cancellingWorkflowJobId === job.jobId ? "Cancelling" : "Cancel"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void forceStopWorkflowRun(job)}
                          disabled={!isActiveStatus || forceStoppingWorkflowJobId === job.jobId}
                          className="rounded-[0.75rem] border border-amber-100 bg-white px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          {forceStoppingWorkflowJobId === job.jobId ? "Stopping" : "Force Stop"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  ;
}

export function OutputsPanel({
  enabled, jobs, loading, error, downloadingJobId, onRefresh, onDownload,
}: {
  enabled: boolean; jobs: ScrapeJobSummary[]; loading: boolean; error: string;
  downloadingJobId: string; onRefresh: () => void | Promise<void>; onDownload: JobAction;
}) {
  if (!enabled) return null;
  const outputWorkflowRuns = jobs;
  const workflowRunsLoading = loading;
  const workflowRunsError = error;
  const downloadingWorkflowJobId = downloadingJobId;
  const refreshWorkflowRuns = onRefresh;
  const downloadWorkflowRun = onDownload;
  return <div className="mx-auto w-full max-w-5xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-emerald-600">Outputs</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">Excel output files</h1>
          <p className="mt-1 text-sm text-slate-600">
            Completed workbooks remain available here after the browser is closed because downloads are created from S3.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshWorkflowRuns()}
          className="inline-flex h-10 items-center justify-center rounded-[0.95rem] border border-emerald-100 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-emerald-50"
        >
          {workflowRunsLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {workflowRunsError ? (
        <div className="mt-5 rounded-[1rem] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load outputs: {workflowRunsError}
        </div>
      ) : outputWorkflowRuns.length === 0 ? (
        <div className="mt-5 rounded-[1rem] border border-dashed border-emerald-200 bg-emerald-50/60 px-4 py-8 text-center text-sm text-slate-500">
          No Excel outputs are available yet.
        </div>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-emerald-100 text-xs uppercase tracking-[0.14em] text-slate-400">
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Output</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Workflow</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Portal</th>
                <th className="min-w-[14rem] px-3 py-3 font-semibold">Source File</th>
                <th className="min-w-[10rem] px-3 py-3 font-semibold">Created By</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Status</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Created</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">End Time</th>
                <th className="whitespace-nowrap px-3 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {outputWorkflowRuns.map((job) => {
                const portalName = claimStatusPortalRegistry.find((portal) => portal.id === job.portalId)?.name ?? job.portalId.toUpperCase();
                const outputArtifact = (job.artifacts ?? []).find(isExcelOutputArtifact);
                const creator = job.createdByName && job.createdByName !== "unknown"
                  ? job.createdByName
                  : job.createdByEmail || job.userId || "unknown";
                const statusClassName =
                  job.status === "completed"
                    ? "bg-emerald-50 text-emerald-700"
                    : job.status === "failed"
                      ? "bg-red-50 text-red-700"
                      : job.status === "cancelled"
                        ? "bg-slate-100 text-slate-600"
                        : "bg-blue-50 text-blue-700";

                return (
                  <tr key={job.jobId} className="border-b border-emerald-50 last:border-0 hover:bg-emerald-50/35">
                    <td className="px-3 py-3">
                      <div className="flex min-w-[12rem] items-center gap-2">
                        <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-600" strokeWidth={2} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-800" title={outputArtifact?.filename || "Output workbook"}>
                            {outputArtifact?.filename || "Output workbook"}
                          </div>
                          <div className="font-mono text-[0.7rem] text-slate-400">{formatShortJobId(job.jobId)}</div>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{formatWorkflowLabel(job.workflowId)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{portalName}</td>
                    <td className="px-3 py-3">
                      <div className="max-w-[18rem] truncate text-xs text-slate-500" title={formatUploadedJobFiles(job)}>
                        {formatUploadedJobFiles(job)}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="max-w-[12rem] truncate text-xs text-slate-600" title={job.createdByEmail || creator}>
                        {creator}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClassName}`}>
                        {job.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.finishedAt || job.updatedAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => void downloadWorkflowRun(job)}
                          disabled={downloadingWorkflowJobId === job.jobId}
                          className="inline-flex items-center gap-2 rounded-[0.75rem] border border-emerald-100 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          <Download className="h-3.5 w-3.5" strokeWidth={2.1} />
                          {downloadingWorkflowJobId === job.jobId ? "Preparing" : "Download"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  ;
}

