import { JobProgress } from "../../components/JobProgress";
import { LogsPanel } from "../../components/LogsPanel";
import { ScreenshotViewer } from "../../components/ScreenshotViewer";
import { StatusMessage } from "../../components/StatusMessage";
import type { ErrorScreenshot, JobProgressValue } from "../../types/job";

export function OptumProResultView({
  errorScreenshots,
  logs,
  canStop,
  isStopping,
  onOtpChange,
  onOtpSubmit,
  onStop,
  otpRequest,
  otpValue,
  progress,
  status,
}: {
  errorScreenshots: ErrorScreenshot[];
  logs: string[];
  canStop?: boolean;
  isStopping?: boolean;
  onOtpChange?: (value: string) => void;
  onOtpSubmit?: () => void;
  onStop?: () => void;
  otpRequest?: { inputName: string; label: string; message: string } | null;
  otpValue?: string;
  progress: JobProgressValue | null;
  status: string;
}) {
  return (
    <>
      <JobProgress progress={progress} />
      {canStop ? (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onStop}
            disabled={isStopping}
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
          >
            {isStopping ? "Stopping..." : "Stop Optum Pro scraping"}
          </button>
        </div>
      ) : null}
      {otpRequest ? (
        <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-4">
          <label className="block text-sm font-medium text-blue-950" htmlFor="optumProOtp">
            {otpRequest.label}
          </label>
          <p className="mt-1 text-sm text-blue-900">{otpRequest.message}</p>
          <div className="mt-3 flex gap-2">
            <input
              id="optumProOtp"
              value={otpValue || ""}
              onChange={(event) => onOtpChange?.(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-blue-300 bg-white px-3 py-2 text-sm"
              inputMode="numeric"
              autoComplete="one-time-code"
            />
            <button
              type="button"
              onClick={onOtpSubmit}
              disabled={!otpValue?.trim()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              Submit OTP
            </button>
          </div>
        </div>
      ) : null}
      <StatusMessage status={status} />
      <ScreenshotViewer screenshots={errorScreenshots} />
      <LogsPanel logs={logs} />
    </>
  );
}
