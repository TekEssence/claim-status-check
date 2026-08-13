import { JobProgress } from "../../../../components/JobProgress";
import { LogsPanel } from "../../../../components/LogsPanel";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { JobProgressValue } from "../../../../types/job";

export function WaystarResultView(props: {
  status: string;
  logs: string[];
  progress: JobProgressValue | null;
}) {
  return (
    <div className="rounded-[1.7rem] border border-sky-100 bg-white/92 p-5 shadow-[0_16px_38px_rgba(148,163,184,0.12)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Run Activity</p>
          <h2 className="mt-2 text-lg font-semibold tracking-[-0.03em] text-slate-950">Eligibility progress</h2>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700">
          <span className="h-2 w-2 rounded-full bg-sky-500" />
          Live updates
        </span>
      </div>

      <div className="mt-5 rounded-[1.2rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(248,252,255,0.98)_0%,rgba(239,246,255,0.88)_100%)] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Current status</p>
        <StatusMessage status={props.status || "Upload the credential and eligibility workbooks to begin the run."} />
        <JobProgress progress={props.progress} />
      </div>

      <div className="mt-5 rounded-[1.2rem] border border-sky-100 bg-white/85 p-4">
        <LogsPanel logs={props.logs} />
        {!props.logs.length ? <p className="text-sm text-slate-400">Live processing updates will appear here once the run starts.</p> : null}
      </div>
    </div>
  );
}
