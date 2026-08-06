"use client";

import { ShieldCheck } from "lucide-react";
import { JobProgress } from "../../../../components/JobProgress";
import { LogsPanel } from "../../../../components/LogsPanel";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { JobProgressValue } from "../../../../types/job";

type AdvancedMdPaymentPostingResultViewProps = {
  jobId: string;
  status: string;
  progress: JobProgressValue | null;
  logs: string[];
  errors: string[];
  canStop: boolean;
  isStopping: boolean;
  onStop: () => void;
};

export function AdvancedMdPaymentPostingResultView({
  jobId,
  status,
  progress,
  logs,
  errors,
  canStop,
  isStopping,
  onStop,
}: AdvancedMdPaymentPostingResultViewProps) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase text-slate-500">Job ID</p>
          <p className="mt-1 break-all text-sm font-medium text-slate-900">{jobId || "Not started"}</p>
        </div>
        <button
          type="button"
          onClick={onStop}
          disabled={!canStop || isStopping}
          className="rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
        >
          {isStopping ? "Stopping..." : "Cancel"}
        </button>
      </div>

      <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <span className="inline-flex items-center gap-2 font-semibold">
          <ShieldCheck className="h-4 w-4" />
          AdvancedMD dry-run browser automation is enabled.
        </span>
        <p className="mt-2">
          The run fills Quick Pay fields, saves screenshots, and exports entered values. The final Post action is never clicked.
        </p>
      </div>

      <JobProgress progress={progress} />
      <StatusMessage status={status} />

      {errors.length > 0 ? (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3">
          <h2 className="mb-2 text-sm font-semibold text-red-700">Errors</h2>
          <ul className="list-disc space-y-1 pl-5 text-xs text-red-700">
            {errors.map((error, index) => (
              <li key={`${error}-${index}`}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <LogsPanel logs={logs} />
    </div>
  );
}
