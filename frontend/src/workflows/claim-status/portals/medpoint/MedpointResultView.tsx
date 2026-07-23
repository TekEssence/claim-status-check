import { LogsPanel } from "../../../../components/LogsPanel";
import { ScreenshotViewer } from "../../../../components/ScreenshotViewer";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { ErrorScreenshot } from "../../../../types/job";

export function MedpointResultView({
  captchaRequest,
  errorScreenshots,
  logs,
  onCaptchaSubmit,
  onOtpChange,
  onOtpSubmit,
  otpRequest,
  otpValue,
  status,
}: {
  captchaRequest?: { inputName: string; label: string; message: string } | null;
  errorScreenshots: ErrorScreenshot[];
  logs: string[];
  onCaptchaSubmit: () => void;
  onOtpChange: (value: string) => void;
  onOtpSubmit: () => void;
  otpRequest?: { inputName: string; label: string; message: string } | null;
  otpValue?: string;
  status: string;
}) {
  return (
    <div>
      {captchaRequest ? (
        <div className="mt-4 rounded-[1.6rem] border border-amber-200 bg-[radial-gradient(circle_at_top,#fff7d6_0%,#fff8e8_38%,#fffdf7_100%)] p-6 shadow-[0_20px_44px_rgba(245,158,11,0.14)]">
          <div className="inline-flex items-center rounded-full border border-amber-300 bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-amber-700">
            Manual step required
          </div>
          <p className="mt-4 text-lg font-semibold text-amber-950">{captchaRequest.label}</p>
          <p className="mt-2 text-sm leading-6 text-amber-900">{captchaRequest.message}</p>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <div className="rounded-[1rem] border border-amber-200/80 bg-white/90 p-4 text-sm text-amber-950">
              <p className="font-semibold">1. Login fields filled</p>
              <p className="mt-2 text-amber-900">Username and password were already entered on the Medpoint page.</p>
            </div>
            <div className="rounded-[1rem] border border-amber-200/80 bg-white/90 p-4 text-sm text-amber-950">
              <p className="font-semibold">2. Complete captcha there</p>
              <p className="mt-2 text-amber-900">Use the Medpoint browser window to finish the real "I'm not a robot" check on that same page.</p>
            </div>
            <div className="rounded-[1rem] border border-amber-200/80 bg-white/90 p-4 text-sm text-amber-950">
              <p className="font-semibold">3. Resume here</p>
              <p className="mt-2 text-amber-900">After the checkbox is done in Medpoint, click Completed below so Playwright can continue.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCaptchaSubmit}
            className="mt-5 inline-flex items-center justify-center rounded-[1rem] bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_14px_26px_rgba(245,158,11,0.28)] transition hover:bg-amber-600"
          >
            Completed
          </button>
        </div>
      ) : null}
      {otpRequest ? (
        <div className="mt-4 rounded-[1.35rem] border border-sky-200 bg-[linear-gradient(180deg,#f8fcff_0%,#eef7ff_100%)] p-5 shadow-[0_16px_34px_rgba(59,130,246,0.12)]">
          <p className="text-sm font-semibold text-sky-950">{otpRequest.label}</p>
          <p className="mt-2 text-sm leading-6 text-sky-900">{otpRequest.message}</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={otpValue || ""}
              onChange={(event) => onOtpChange(event.target.value)}
              className="min-w-0 flex-1 rounded-[1rem] border border-sky-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none ring-0 transition focus:border-sky-400"
              placeholder="Enter OTP"
            />
            <button
              type="button"
              onClick={onOtpSubmit}
              disabled={!otpValue?.trim()}
              className="inline-flex items-center justify-center rounded-[1rem] bg-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-[0_14px_26px_rgba(59,130,246,0.22)] transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
            >
              Submit OTP
            </button>
          </div>
        </div>
      ) : null}
      <StatusMessage status={status} />
      <ScreenshotViewer screenshots={errorScreenshots} />
      <LogsPanel logs={logs} />
    </div>
  );
}
