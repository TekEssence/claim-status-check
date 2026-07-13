import { JobProgress } from "../../components/JobProgress";
import { LogsPanel } from "../../components/LogsPanel";
import { ScreenshotViewer } from "../../components/ScreenshotViewer";
import { StatusMessage } from "../../components/StatusMessage";
import type { ErrorScreenshot, JobProgressValue } from "../../types/job";

const OPTUM_PRO_OTP_MAX_LENGTH = 8;

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
            className="inline-flex items-center justify-center rounded-[1rem] border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 shadow-sm transition hover:bg-red-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
          >
            {isStopping ? "Stopping..." : "Stop Optum Pro scraping"}
          </button>
        </div>
      ) : null}
      {otpRequest ? (
        <div className="mt-4 rounded-[1.4rem] border border-sky-200 bg-[linear-gradient(180deg,rgba(239,246,255,0.95),rgba(224,242,254,0.88))] p-5 shadow-[0_18px_36px_rgba(14,116,144,0.12)]">
          <label className="block text-sm font-semibold uppercase tracking-[0.18em] text-sky-900" htmlFor="optumProOtp">
            {otpRequest.label}
          </label>
          <p className="mt-2 text-sm leading-6 text-sky-900/90">{otpRequest.message}</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              id="optumProOtp"
              type="text"
              name="otp"
              value={(otpValue || "").slice(0, OPTUM_PRO_OTP_MAX_LENGTH)}
              onChange={(event) => onOtpChange?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && otpValue?.trim()) {
                  event.preventDefault();
                  onOtpSubmit?.();
                }
              }}
              className="input-code min-w-0 flex-1 rounded-[0.95rem] border border-slate-300 bg-white px-4 py-3 text-center text-lg font-semibold tracking-[0.32em] text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-200"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoCorrect="off"
              autoCapitalize="off"
              maxLength={OPTUM_PRO_OTP_MAX_LENGTH}
            />
            <button
              type="button"
              onClick={onOtpSubmit}
              disabled={!otpValue?.trim()}
              className="rounded-[0.95rem] bg-sky-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              Confirm
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
