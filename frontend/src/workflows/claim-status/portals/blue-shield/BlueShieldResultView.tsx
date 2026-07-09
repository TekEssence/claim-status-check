import { LogsPanel } from "../../../../components/LogsPanel";
import { ScreenshotViewer } from "../../../../components/ScreenshotViewer";
import { StatusMessage } from "../../../../components/StatusMessage";
import type { ErrorScreenshot } from "../../../../types/job";

const BLUE_SHIELD_OTP_LENGTH = 6;

export function BlueShieldResultView({
  errorScreenshots,
  logs,
  onOtpChange,
  onOtpSubmit,
  otpRequest,
  otpValue,
  status,
}: {
  errorScreenshots: ErrorScreenshot[];
  logs: string[];
  onOtpChange?: (value: string) => void;
  onOtpSubmit?: () => void;
  otpRequest?: { inputName: string; label: string; message: string } | null;
  otpValue?: string;
  status: string;
}) {
  const normalizedOtpValue = (otpValue || "").replace(/\D/g, "").slice(0, BLUE_SHIELD_OTP_LENGTH);
  const isOtpComplete = normalizedOtpValue.length === BLUE_SHIELD_OTP_LENGTH;

  return (
    <>
      {otpRequest ? (
        <div className="mt-4 rounded-[1.4rem] border border-sky-200 bg-[linear-gradient(180deg,rgba(239,246,255,0.95),rgba(224,242,254,0.88))] p-5 shadow-[0_18px_36px_rgba(14,116,144,0.12)]">
          <label className="block text-sm font-semibold uppercase tracking-[0.18em] text-sky-900" htmlFor="blueShieldOtp">
            {otpRequest.label}
          </label>
          <p className="mt-2 text-sm leading-6 text-sky-900/90">{otpRequest.message}</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              id="blueShieldOtp"
              type="text"
              name="otp"
              value={normalizedOtpValue}
              onChange={(event) => onOtpChange?.(event.target.value.replace(/\D/g, "").slice(0, BLUE_SHIELD_OTP_LENGTH))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isOtpComplete) {
                  event.preventDefault();
                  onOtpSubmit?.();
                }
              }}
              className="input-code min-w-0 flex-1 rounded-[0.95rem] border border-slate-300 bg-white px-4 py-3 text-center text-lg font-semibold tracking-[0.42em] text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-200"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoCorrect="off"
              autoCapitalize="off"
              maxLength={BLUE_SHIELD_OTP_LENGTH}
              required
              aria-errormessage="errorTxt"
              aria-invalid="false"
            />
            <button
              type="button"
              onClick={onOtpSubmit}
              disabled={!isOtpComplete}
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


