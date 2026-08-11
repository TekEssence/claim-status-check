import { JobProgress } from "../../../../components/JobProgress";
import { LogsPanel } from "../../../../components/LogsPanel";
import { ScreenshotViewer } from "../../../../components/ScreenshotViewer";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { ErrorScreenshot, JobProgressValue } from "../../../../types/job";

export type UhcProviderPrompt = {
  inputName: string;
  providerStage: "corporate" | "care";
  corporateTaxIdOwners: string[];
  careProviders: string[];
  value: string;
  label: string;
  message: string;
};

export function UhcResultView({
  errorScreenshots,
  logs,
  onOtpChange,
  onOtpSubmit,
  onProviderChange,
  onProviderSubmit,
  otpRequest,
  otpValue,
  progress,
  providerPrompt,
  status,
}: {
  errorScreenshots: ErrorScreenshot[];
  logs: string[];
  onOtpChange: (value: string) => void;
  onOtpSubmit: () => void;
  onProviderChange: (value: string) => void;
  onProviderSubmit: () => void;
  otpRequest: { inputName: string; label: string; message: string } | null;
  otpValue: string;
  progress: JobProgressValue | null;
  providerPrompt: UhcProviderPrompt | null;
  status: string;
}) {
  const providerOptions = providerPrompt?.providerStage === "corporate"
    ? providerPrompt.corporateTaxIdOwners
    : providerPrompt?.careProviders ?? [];

  return (
    <>
      {otpRequest || providerPrompt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-[1.4rem] border border-blue-100 bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.28)]">
            {otpRequest ? (
              <>
                <p className="text-sm font-semibold text-blue-950">{otpRequest.label}</p>
                <p className="mt-1 text-sm text-slate-600">{otpRequest.message}</p>
                <input
                  value={otpValue}
                  onChange={(event) => onOtpChange(event.target.value.replace(/\D/g, "").slice(0, 10))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && otpValue.trim()) onOtpSubmit();
                  }}
                  className="mt-4 w-full rounded-[0.9rem] border border-blue-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={onOtpSubmit}
                  disabled={!otpValue.trim()}
                  className="mt-4 w-full rounded-[1rem] bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  Continue
                </button>
              </>
            ) : providerPrompt ? (
              <>
                <p className="text-sm font-semibold text-blue-950">{providerPrompt.label}</p>
                <p className="mt-1 text-sm text-slate-600">{providerPrompt.message}</p>
                <select
                  className="mt-4 w-full rounded-[0.9rem] border border-blue-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                  value={providerPrompt.value}
                  onChange={(event) => onProviderChange(event.target.value)}
                  autoFocus
                >
                  {providerOptions.length === 0 ? <option value="">No option found</option> : null}
                  {providerOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={onProviderSubmit}
                  disabled={!providerPrompt.value}
                  className="mt-4 w-full rounded-[1rem] bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  Continue
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      <JobProgress progress={progress} />
      <StatusMessage status={status} />
      <ScreenshotViewer screenshots={errorScreenshots} />
      <LogsPanel logs={logs} />
    </>
  );
}
