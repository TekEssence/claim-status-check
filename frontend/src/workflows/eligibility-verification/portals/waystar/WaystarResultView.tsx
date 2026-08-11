import { JobProgress } from "../../../../components/JobProgress";
import { LogsPanel } from "../../../../components/LogsPanel";
import { ScreenshotViewer } from "../../../../components/ScreenshotViewer";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { ErrorScreenshot, JobProgressValue } from "../../../../types/job";

export function WaystarResultView(props: {
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

  return (
    <div className="rounded-[1.7rem] border border-sky-100 bg-white/92 p-5 shadow-[0_16px_38px_rgba(148,163,184,0.12)]">
      <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Run Activity</p>
      <JobProgress progress={props.progress} />
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
