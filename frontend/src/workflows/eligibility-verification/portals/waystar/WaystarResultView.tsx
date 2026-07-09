import { CheckCircle2 } from "lucide-react";

export function WaystarResultView(props: {
  status: string;
  logs: string[];
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold">Run activity</h2>
      {props.status && <p className="mt-3 text-sm text-slate-700">{props.status}</p>}
      <div className="mt-4 max-h-72 space-y-2 overflow-auto">
        {props.logs.length ? props.logs.map((log, index) => (
          <div key={`${index}-${log}`} className="flex gap-2 text-xs text-slate-600">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
            {log}
          </div>
        )) : <p className="text-sm text-slate-400">No activity yet.</p>}
      </div>
    </div>
  );
}
