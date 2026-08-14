import { JobProgress } from "../../../../components/JobProgress";
import { LogsPanel } from "../../../../components/LogsPanel";
import { ScreenshotViewer } from "../../../../components/ScreenshotViewer";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { ErrorScreenshot, JobProgressValue } from "../../../../types/job";

export function AvailityResultView({
  canDownloadOutput,
  errorScreenshots,
  logs,
  onOutputDownload,
  onOtpChange,
  onOtpSubmit,
  outputCompleted,
  outputTotal,
  otpRequest,
  otpValue,
  progress,
  status,
}: {
  canDownloadOutput?: boolean;
  errorScreenshots: ErrorScreenshot[];
  logs: string[];
  onOutputDownload?: () => void | Promise<void>;
  onOtpChange?: (value: string) => void;
  onOtpSubmit?: () => void;
  outputCompleted?: number;
  outputTotal?: number;
  otpRequest?: { inputName: string; label: string; message: string } | null;
  otpValue?: string;
  progress: JobProgressValue | null;
  status: string;
}) {
  return (
    <>
      {otpRequest ? (
        <div className="mb-4 rounded-[1.2rem] border border-blue-200 bg-blue-50 p-4">
          <label className="block text-sm font-semibold text-blue-950" htmlFor="availityOtp">
            {otpRequest.label}
          </label>
          <p className="mt-1 text-sm text-blue-900">{otpRequest.message}</p>
          <div className="mt-3 flex gap-2">
            <input
              id="availityOtp"
              value={otpValue || ""}
              onChange={(event) => onOtpChange?.(event.target.value.replace(/\D/g, "").slice(0, 8))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && otpValue?.trim()) {
                  onOtpSubmit?.();
                }
              }}
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
      <JobProgress progress={progress} />
      <StatusMessage status={status} />
      {canDownloadOutput ? (
        <div className="mb-4 rounded-[1.2rem] border border-blue-100 bg-white p-4 shadow-sm">
          <p className="text-sm text-slate-600">
            Latest Availity workbook is ready
            {typeof outputCompleted === "number" && typeof outputTotal === "number" ? ` through ${outputCompleted} of ${outputTotal} input rows` : ""}.
          </p>
          <button
            type="button"
            onClick={onOutputDownload}
            className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Download current results
          </button>
        </div>
      ) : null}
      <ScreenshotViewer screenshots={errorScreenshots} />
      <LogsPanel logs={logs} />
    </>
  );
}
