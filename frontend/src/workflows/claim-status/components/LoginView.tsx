import Image from "next/image";
import type { Dispatch, FormEventHandler, SetStateAction } from "react";
import claimStatusHeroImage from "../../../Assets/ChatGPT Image Jun 30, 2026, 12_47_57 PM.png";

export function LoginView({
  isProtectedRoute, forgotPasswordMode, authUsername, authPassword,
  authConfirmPassword, authError, authStatus, authSubmitting,
  setAuthUsername, setAuthPassword, setAuthConfirmPassword,
  onAuthSubmit, onForgotPasswordSubmit, onShowForgotPassword, onBackToLogin,
}: {
  isProtectedRoute: boolean; forgotPasswordMode: boolean; authUsername: string;
  authPassword: string; authConfirmPassword: string; authError: string;
  authStatus: string; authSubmitting: boolean;
  setAuthUsername: Dispatch<SetStateAction<string>>;
  setAuthPassword: Dispatch<SetStateAction<string>>;
  setAuthConfirmPassword: Dispatch<SetStateAction<string>>;
  onAuthSubmit: FormEventHandler<HTMLFormElement>;
  onForgotPasswordSubmit: FormEventHandler<HTMLFormElement>;
  onShowForgotPassword: () => void; onBackToLogin: () => void;
}) {
if (isProtectedRoute) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.98)_0%,_rgba(240,246,255,0.98)_44%,_rgba(227,238,255,0.95)_100%)] px-4 text-slate-900">
          <div className="rounded-2xl border border-sky-100 bg-white/90 px-5 py-4 text-sm font-medium shadow-[0_18px_40px_rgba(148,163,184,0.14)] backdrop-blur-xl">
            Redirecting to login...
          </div>
        </main>
      );
    }

    return (
      <main className="h-screen w-screen overflow-hidden bg-[#f5faff] text-slate-900">
        {forgotPasswordMode ? (
          <div className="relative flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#edf5ff_0%,#d9eaff_52%,#3b82f6_100%)] px-4">
            <div className="w-full max-w-md rounded-[28px] border border-white/80 bg-white/92 p-6 shadow-[0_32px_80px_rgba(15,23,42,0.14)]">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Reset Password</h1>
              <p className="mt-2 text-sm text-slate-500">Update your password to continue.</p>

              <form className="mt-6 space-y-4" onSubmit={onForgotPasswordSubmit}>
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" htmlFor="authUsername">
                    Username
                  </label>
                  <input
                    id="authUsername"
                    type="text"
                    autoComplete="username"
                    value={authUsername}
                    onChange={(event) => setAuthUsername(event.target.value)}
                    className="block w-full rounded-2xl border border-blue-100 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" htmlFor="authPassword">
                    New Password
                  </label>
                  <input
                    id="authPassword"
                    type="password"
                    autoComplete="new-password"
                    value={authPassword}
                    onChange={(event) => setAuthPassword(event.target.value)}
                    className="block w-full rounded-2xl border border-blue-100 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" htmlFor="authConfirmPassword">
                    Confirm Password
                  </label>
                  <input
                    id="authConfirmPassword"
                    type="password"
                    autoComplete="new-password"
                    value={authConfirmPassword}
                    onChange={(event) => setAuthConfirmPassword(event.target.value)}
                    className="block w-full rounded-2xl border border-blue-100 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                  />
                </div>

                {authError && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 shadow-sm">
                    {authError}
                  </div>
                )}

                {authStatus && (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700 shadow-sm">
                    {authStatus}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full rounded-2xl bg-[linear-gradient(135deg,#2563eb,#1d4ed8_55%,#0ea5e9)] px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_35px_rgba(37,99,235,0.32)] disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  {authSubmitting ? "Please wait..." : "Update Password"}
                </button>

                <button
                  type="button"
                  onClick={onBackToLogin}
                  className="w-full text-center text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  Back to login
                </button>
              </form>
            </div>
          </div>
        ) : (
          <>
            <div className="relative hidden h-full w-full md:block">
              <Image
                src={claimStatusHeroImage}
                alt="Claim Status Portal login background"
                fill
                priority
                className="pointer-events-none object-cover object-center select-none"
              />

              <form className="absolute inset-0" onSubmit={onAuthSubmit}>
                <label className="sr-only" htmlFor="authUsername">
                  Username
                </label>
                <input
                  id="authUsername"
                  type="text"
                  autoComplete="off"
                  value={authUsername}
                  onChange={(event) => setAuthUsername(event.target.value)}
                  className="absolute right-[9.65%] top-[43.45%] h-[4.7%] w-[34.3%] rounded-[14px] border-none bg-transparent px-[10.5%] text-[clamp(0.95rem,1vw,1.05rem)] font-medium text-slate-800 outline-none placeholder-transparent focus:bg-white/6"
                />

                <label className="sr-only" htmlFor="authPassword">
                  Password
                </label>
                <input
                  id="authPassword"
                  type="password"
                  autoComplete="off"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                  className="absolute right-[9.65%] top-[59.25%] h-[4.7%] w-[34.3%] rounded-[14px] border-none bg-transparent px-[10.5%] text-[clamp(0.95rem,1vw,1.05rem)] font-medium text-slate-800 outline-none placeholder-transparent focus:bg-white/6"
                />

                <label className="absolute right-[31.9%] top-[69.05%] flex items-center gap-2 text-[clamp(0.82rem,0.86vw,0.92rem)] text-transparent">
                  <input className="h-5 w-5 cursor-pointer opacity-0" type="checkbox" defaultChecked aria-label="Remember me" />
                  <span className="select-none">Remember me</span>
                </label>

                <button
                  type="button"
                  onClick={onShowForgotPassword}
                  className="absolute right-[9.55%] top-[68.7%] h-[3.8%] w-[13.4%] text-transparent"
                >
                  Forgot password?
                </button>

                {authError && (
                  <div className="absolute right-[9.65%] top-[74.7%] w-[34.3%] rounded-2xl border border-red-200 bg-red-50/95 px-4 py-3 text-sm font-medium text-red-700 shadow-sm">
                    {authError}
                  </div>
                )}

                {authStatus && (
                  <div className="absolute right-[9.65%] top-[74.7%] w-[34.3%] rounded-2xl border border-emerald-200 bg-emerald-50/95 px-4 py-3 text-sm font-medium text-emerald-700 shadow-sm">
                    {authStatus}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="absolute right-[9.65%] top-[74.15%] h-[6.7%] w-[34.3%] rounded-[18px] bg-transparent text-transparent disabled:cursor-not-allowed"
                >
                  {authSubmitting ? "Please wait..." : "Login"}
                </button>
              </form>
            </div>

            <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#edf5ff_0%,#d9eaff_52%,#3b82f6_100%)] px-4 md:hidden">
              <div className="w-full max-w-sm rounded-[28px] border border-white/80 bg-white/95 p-6 shadow-[0_32px_80px_rgba(15,23,42,0.14)]">
                <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Claim Status Portal</h1>
                <p className="mt-2 text-sm text-slate-500">Sign in to continue to your dashboard.</p>

                <form className="mt-6 space-y-4" onSubmit={onAuthSubmit}>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700" htmlFor="authUsernameMobile">
                      Username
                    </label>
                    <input
                      id="authUsernameMobile"
                      type="text"
                      autoComplete="off"
                      value={authUsername}
                      onChange={(event) => setAuthUsername(event.target.value)}
                      className="block h-12 w-full rounded-2xl border border-blue-100 bg-white px-4 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700" htmlFor="authPasswordMobile">
                      Password
                    </label>
                    <input
                      id="authPasswordMobile"
                      type="password"
                      autoComplete="off"
                      value={authPassword}
                      onChange={(event) => setAuthPassword(event.target.value)}
                      className="block h-12 w-full rounded-2xl border border-blue-100 bg-white px-4 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4 text-sm">
                    <label className="flex items-center gap-2 text-slate-600">
                      <input className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" type="checkbox" defaultChecked />
                      <span>Remember me</span>
                    </label>
                    <button
                      type="button"
                      onClick={onShowForgotPassword}
                      className="font-medium text-blue-600 hover:text-blue-700"
                    >
                      Forgot password?
                    </button>
                  </div>

                  {authError && (
                    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 shadow-sm">
                      {authError}
                    </div>
                  )}

                  {authStatus && (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700 shadow-sm">
                      {authStatus}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={authSubmitting}
                    className="h-12 w-full rounded-2xl bg-[linear-gradient(135deg,#1692ff,#214edc_55%,#1e40d4)] text-base font-semibold text-white shadow-[0_16px_28px_rgba(29,78,216,0.28)] transition hover:brightness-[1.03] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {authSubmitting ? "Please wait..." : "Login"}
                  </button>
                </form>
              </div>
            </div>
          </>
        )}
      </main>
    );
}
