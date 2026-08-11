import { JobProgress } from "../../../../components/JobProgress";
import { LogsPanel } from "../../../../components/LogsPanel";
import { ScreenshotViewer } from "../../../../components/ScreenshotViewer";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { ErrorScreenshot, JobProgressValue } from "../../../../types/job";

export function AstronaResultView({ errorScreenshots, isProcessing, logs, progress, rows, status }: { errorScreenshots: ErrorScreenshot[]; isProcessing: boolean; logs: string[]; progress: JobProgressValue | null; rows: Record<string, unknown>[]; status: string }) {
  const columns = ["input_row_id", "member_id", "member_name", "input_dos", "input_cpt", "claim_number", "portal_status", "claim_outcome", "net_amount", "result"];
  return <>
    {isProcessing && <div className="mb-4 flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-900"><span className="h-3 w-3 animate-pulse rounded-full bg-blue-600" />Astrona is processing and extracting data…</div>}
    <JobProgress progress={progress} /><StatusMessage status={status} />
    {rows.length > 0 && <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Live extracted data ({rows.length} output rows)</div><div className="max-h-96 overflow-auto"><table className="min-w-full text-left text-xs"><thead className="sticky top-0 bg-slate-100 text-slate-700"><tr>{columns.map((column) => <th className="whitespace-nowrap px-3 py-2 font-semibold" key={column}>{column.replaceAll("_", " ")}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr className="border-t border-slate-100" key={`${String(row.input_row_id)}-${String(row.claim_number)}-${index}`}>{columns.map((column) => <td className="max-w-64 whitespace-nowrap px-3 py-2 text-slate-700" key={column} title={String(row[column] ?? "")}>{String(row[column] ?? "") || "—"}</td>)}</tr>)}</tbody></table></div></div>}
    <ScreenshotViewer screenshots={errorScreenshots} /><LogsPanel logs={logs} />
  </>;
}
