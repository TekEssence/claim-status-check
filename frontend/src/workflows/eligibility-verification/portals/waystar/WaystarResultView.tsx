import { JobProgress } from "../../../../components/JobProgress";
import { LogsPanel } from "../../../../components/LogsPanel";
import { ScreenshotViewer } from "../../../../components/ScreenshotViewer";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { ErrorScreenshot, JobProgressValue } from "../../../../types/job";

export function WaystarResultView(props: {
  isWaystar?: boolean;
  isRunning?: boolean;
  hasCompleted?: boolean;
  status: string;
  logs: string[];
  errorScreenshots: ErrorScreenshot[];
  progress: JobProgressValue | null;
  downloads: Array<{ filename: string; base64: string; mimeType: string }>;
  resultRows?: Array<Record<string, string>>;
  onDownload: (filename: string, base64: string, mimeType: string) => void;
}) {
  const visibleResultHeaders = props.resultRows?.[0]
    ? Object.keys(props.resultRows[0]).filter((header) => !header.startsWith("__"))
    : [];
  const liveErrors = props.resultRows
    ?.map((row) => row.__error)
    .filter(Boolean) ?? [];
  const total = Math.max(0, props.progress?.total ?? 0);
  const processed = Math.min(total, Math.max(0, props.progress?.completed ?? 0));
  const remaining = total - processed;
  const percent = total > 0 ? Math.floor(processed / total * 100) : 0;
  const runLabel = props.isRunning
    ? total > 0 && remaining === 0 ? "Preparing output…" : "Verification running"
    : props.hasCompleted ? "Verification completed" : "Verification stopped";

  return (
    <div className="rounded-[1.7rem] border border-sky-100 bg-white/92 p-5 shadow-[0_16px_38px_rgba(148,163,184,0.12)]">
      <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Run Activity</p>
      {props.isWaystar && (props.progress || props.isRunning || props.hasCompleted) ? (
        <div className="mt-5 space-y-3">
          <p role="status" className="font-semibold text-slate-900">{runLabel}</p>
          {total > 0 ? <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-lg font-semibold text-slate-900">{processed} of {total} rows processed</p>
              <p className="text-sm text-slate-600">{remaining} rows remaining · {percent}%</p>
            </div>
            <div role="progressbar" aria-label="Rows processed" aria-valuemin={0} aria-valuemax={total} aria-valuenow={processed} className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-slate-500">Processed includes successful and failed rows. Rows awaiting retry remain in the remaining count.</p>
          </> : <p className="text-sm text-slate-600">Preparing the run and reading the input file…</p>}
          {props.isRunning && remaining > 0 && props.progress?.payerName ? (
            <div className="rounded-xl bg-sky-50 p-3 text-sm text-slate-700">
              <p>Current payer: <strong>{props.progress.payerName}</strong></p>
              {props.progress.currentRow != null ? <p className="mt-1">{props.progress.stage === "retrying" ? "Retrying" : "Working on"} Excel row {props.progress.currentRow} <span className="text-slate-500">(file reference only)</span></p> : null}
              {typeof props.progress.pendingRetries === "number" ? <p className="mt-1">Unfinished retry rows for this payer: {props.progress.pendingRetries}</p> : null}
            </div>
          ) : null}
          <p className="text-xs text-slate-500">Rows are grouped by payer, so Excel row references can jump. Overall progress counts each finished row once.</p>
        </div>
      ) : <JobProgress progress={props.progress} />}
      <StatusMessage status={props.status} />
      {props.downloads.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {props.downloads.map((download) => (
            <button
              key={download.filename}
              type="button"
              onClick={() => props.onDownload(download.filename, download.base64, download.mimeType)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              Download {download.filename}
            </button>
          ))}
        </div>
      ) : null}
      {props.resultRows && props.resultRows.length > 0 ? (
        <div className="mt-5 overflow-x-auto rounded-xl border border-sky-100">
          <table className="min-w-max text-left text-sm">
            <thead className="bg-sky-50 text-slate-700">
              <tr>{visibleResultHeaders.map((header) => <th key={header} className="whitespace-nowrap border-b border-sky-100 px-3 py-2 font-semibold">{header}</th>)}</tr>
            </thead>
            <tbody>
              {props.resultRows.map((row, index) => (
                <tr key={index} className="bg-white">
                  {visibleResultHeaders.map((header) => <td key={header} className="whitespace-nowrap border-b border-sky-50 px-3 py-2 text-slate-700">{row[header] || ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {liveErrors.length > 0 ? (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {liveErrors.map((message, index) => <p key={`${index}-${message}`}>{message}</p>)}
        </div>
      ) : null}
      <ScreenshotViewer screenshots={props.errorScreenshots} />
      <LogsPanel logs={props.logs} />
      {!props.status && !props.progress && props.logs.length === 0 && props.errorScreenshots.length === 0 ? <p className="mt-4 text-sm text-slate-400">No activity yet.</p> : null}
    </div>
  );
}
