import { LogsPanel } from "../../../../components/LogsPanel";
import { ScreenshotViewer } from "../../../../components/ScreenshotViewer";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { ErrorScreenshot } from "../../../../types/job";

type MfaOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
};

export function RegalResultView({
  canDownloadOutput,
  errorScreenshots,
  logs,
  mfaRequest,
  mfaValue,
  onMfaChange,
  onMfaSubmit,
  onOutputDownload,
  onOtpChange,
  onOtpSubmit,
  otpRequest,
  otpValue,
  outputCompleted,
  outputTotal,
  status,
}: {
  canDownloadOutput?: boolean;
  errorScreenshots: ErrorScreenshot[];
  logs: string[];
  mfaRequest?: { inputName: string; label: string; message: string; options: MfaOption[] } | null;
  mfaValue?: string;
  onMfaChange?: (value: string) => void;
  onMfaSubmit?: () => void;
  onOutputDownload?: () => void;
  onOtpChange?: (value: string) => void;
  onOtpSubmit?: () => void;
  otpRequest?: { inputName: string; label: string; message: string } | null;
  otpValue?: string;
  outputCompleted?: number;
  outputTotal?: number;
  status: string;
}) {
  return (
    <>
      {mfaRequest ? (
        <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-4">
          <div className="text-sm font-medium text-blue-950">{mfaRequest.label}</div>
          <p className="mt-1 text-sm text-blue-900">{mfaRequest.message}</p>
          <div className="mt-3 space-y-2">
            {mfaRequest.options.map((option) => (
              <label
                key={option.value}
                className={`block rounded-md border bg-white p-3 text-sm ${
                  option.disabled
                    ? "cursor-not-allowed border-slate-200 text-slate-400"
                    : "cursor-pointer border-blue-200 text-slate-900"
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="regalMfaMethod"
                    value={option.value}
                    checked={mfaValue === option.value}
                    disabled={option.disabled}
                    onChange={(event) => onMfaChange?.(event.target.value)}
                    className="mt-1"
                  />
                  <div>
                    <div className="font-medium">{option.label}</div>
                    {option.description ? <div className="mt-1 text-xs text-slate-600">{option.description}</div> : null}
                    {option.disabledReason ? <div className="mt-1 text-xs text-slate-500">{option.disabledReason}</div> : null}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={onMfaSubmit}
            disabled={!mfaValue?.trim()}
            className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            Continue
          </button>
        </div>
      ) : null}
      {otpRequest ? (
        <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-4">
          <label className="block text-sm font-medium text-blue-950" htmlFor="regalOtp">
            {otpRequest.label}
          </label>
          <p className="mt-1 text-sm text-blue-900">{otpRequest.message}</p>
          <div className="mt-3 flex gap-2">
            <input
              id="regalOtp"
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
      <div className="mt-4 rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-900">Regal extracted results</div>
            <div className="mt-1 text-sm text-slate-600">
              {canDownloadOutput
                ? `Latest workbook is ready${typeof outputCompleted === "number" && typeof outputTotal === "number" ? ` through ${outputCompleted} of ${outputTotal} input rows` : ""}.`
                : "A workbook will be available after the first input row is fully processed."}
            </div>
          </div>
          <button
            type="button"
            onClick={onOutputDownload}
            disabled={!canDownloadOutput}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            Download current results
          </button>
        </div>
      </div>
      <StatusMessage status={status} />
      <ScreenshotViewer screenshots={errorScreenshots} />
      <LogsPanel logs={logs} />
    </>
  );
}


