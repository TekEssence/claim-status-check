import { Activity, CheckCircle2, Sparkles } from "lucide-react";

export function WaystarResultView(props: {
  status: string;
  logs: string[];
}) {
  return (
    <div className="rounded-[1.7rem] border border-sky-100 bg-white/92 p-5 shadow-[0_16px_38px_rgba(148,163,184,0.12)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Run Activity</p>
          <h2 className="mt-2 text-lg font-semibold tracking-[-0.03em] text-slate-950">Eligibility progress</h2>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700">
          <Sparkles className="h-3.5 w-3.5" strokeWidth={2.2} />
          Live updates
        </span>
      </div>

      <div className="mt-5 rounded-[1.2rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(248,252,255,0.98)_0%,rgba(239,246,255,0.88)_100%)] p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-[linear-gradient(135deg,#dbeafe_0%,#bfdbfe_100%)] text-blue-700 shadow-inner">
            <Activity className="h-4.5 w-4.5" strokeWidth={2.2} />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Current status</p>
            <p className="mt-1 text-sm leading-6 text-slate-700">
              {props.status || "Upload the credential and eligibility workbooks to begin the run."}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 rounded-[1.2rem] border border-sky-100 bg-white/85 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-slate-900">Event log</p>
          <span className="text-xs font-medium text-slate-400">{props.logs.length} updates</span>
        </div>
        <div className="mt-4 max-h-80 space-y-3 overflow-auto pr-1">
          {props.logs.length ? props.logs.map((log, index) => (
            <div key={`${index}-${log}`} className="flex gap-3 rounded-[1rem] border border-slate-100 bg-slate-50/80 px-3 py-3 text-sm text-slate-600">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" strokeWidth={2.2} />
              <span>{log}</span>
            </div>
          )) : <p className="text-sm text-slate-400">No activity yet.</p>}
        </div>
      </div>
    </div>
  );
}
