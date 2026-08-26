import {
  Activity, ArrowLeft, FileSpreadsheet, LayoutDashboard, LogOut,
  ShieldEllipsis, Stethoscope, Users,
} from "lucide-react";
import Image from "next/image";
import type { AuthUser } from "../shared/model";

type ActiveView = "portal-selection" | "manage-users" | "reset-password" | "outputs";

export function ClaimStatusTopNav(p: {
  userLabel: string; hasSelectedPortal: boolean; onResetPortal: () => void; onBack: () => void;
}) {
  const resetPortalSelection = p.onResetPortal;
  const authUser = { email: p.userLabel, username: p.userLabel };
  const effectivePortalId = p.hasSelectedPortal ? "selected" : null;
  const router = { push: (_path: string) => p.onBack() };
  return (
<nav className="relative z-30 border-b border-sky-100/80 bg-white/80 px-4 py-4 shadow-[0_10px_35px_rgba(148,163,184,0.12)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <button
            type="button"
            onClick={resetPortalSelection}
            className="flex items-center gap-3 text-left"
          >
            <span className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-[1.15rem] border border-sky-200 bg-white shadow-[0_18px_36px_rgba(37,99,235,0.2)]">
              <Image
                src="/opus-logo-2.jpg"
                alt="OPUS logo"
                fill
                className="object-contain p-1"
              />
            </span>
            <span>
              <span className="block text-lg font-semibold tracking-[-0.03em] text-slate-950">Claim Status Portal</span>
              <span className="block text-xs text-slate-500">Multi-portal workspace | Signed in as {authUser.email || authUser.username}</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (effectivePortalId) {
                resetPortalSelection();
              } else {
                router.push("/portal");
              }
            }}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>
      </nav>
  );
}

export function ClaimStatusSidebar(p: {
  activeView: ActiveView; hasSelectedPortal: boolean; mustResetPassword: boolean;
  hasFullAccess: boolean; processingBlocked: boolean;
  onDashboard: () => void; onOutputs: () => void; onChangePortal: () => void;
  onResetPassword: () => void; onManageUsers: () => void; onLogout: () => void;
}) {
  const activeView = p.activeView;
  const effectivePortalId = p.hasSelectedPortal ? "selected" : null;
  const authUser = { mustResetPassword: p.mustResetPassword } as AuthUser;
  const blockPortalFormForProcessing = p.processingBlocked;
  const setActiveView = (_view: ActiveView) => p.onDashboard();
  const router = { push: (_path: string) => p.onDashboard() };
  const refreshWorkflowRuns = p.onOutputs;
  const resetPortalSelection = p.onChangePortal;
  const openResetPassword = p.onResetPassword;
  const hasFullWorkflowAccess = (_user: AuthUser) => p.hasFullAccess;
  const openManageUsers = p.onManageUsers;
  const logout = p.onLogout;
  return (
<aside className="hidden rounded-[2rem] border border-sky-100 bg-white/82 p-4 shadow-[0_18px_60px_rgba(148,163,184,0.14)] backdrop-blur-xl xl:flex xl:min-h-[calc(100vh-10rem)] xl:flex-col 2xl:p-5">
            <div className="flex items-center gap-3 rounded-[1.4rem] bg-[linear-gradient(135deg,rgba(239,246,255,0.98)_0%,rgba(219,234,254,0.82)_100%)] p-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#1473ff_0%,#2563eb_60%,#183db9_100%)] text-white shadow-[0_16px_34px_rgba(37,99,235,0.22)]">
                <Stethoscope className="h-5 w-5" strokeWidth={2.1} />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-950">Claim Status Portal</p>
                <p className="text-xs text-slate-500">Healthcare Automation Platform</p>
              </div>
            </div>

            <nav className="mt-6 space-y-1.5">
              <button
                type="button"
                onClick={() => {
                  setActiveView("portal-selection");
                  router.push("/portal");
                }}
                className={`flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium transition ${
                  activeView === "portal-selection"
                    ? "bg-[linear-gradient(90deg,rgba(37,99,235,0.12)_0%,rgba(37,99,235,0.04)_100%)] text-blue-700"
                    : "text-slate-600 hover:bg-sky-50 hover:text-slate-900"
                }`}
              >
                <LayoutDashboard className="h-4 w-4" strokeWidth={2} />
                Dashboard
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveView("outputs");
                  void refreshWorkflowRuns();
                }}
                className={`flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium transition ${
                  activeView === "outputs"
                    ? "bg-[linear-gradient(90deg,rgba(16,185,129,0.13)_0%,rgba(16,185,129,0.04)_100%)] text-emerald-700"
                    : "text-slate-600 hover:bg-sky-50 hover:text-slate-900"
                }`}
              >
                <FileSpreadsheet className="h-4 w-4" strokeWidth={2} />
                Outputs
              </button>
              {effectivePortalId && !authUser.mustResetPassword ? (
                <button
                  type="button"
                  disabled={blockPortalFormForProcessing}
                  onClick={resetPortalSelection}
                  className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  <Activity className="h-4 w-4" strokeWidth={2} />
                  Change Portal
                </button>
              ) : null}
              <button
                type="button"
                onClick={openResetPassword}
                className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900"
              >
                <ShieldEllipsis className="h-4 w-4" strokeWidth={2} />
                Reset Password
              </button>
              {hasFullWorkflowAccess(authUser) && (
                <button
                  type="button"
                  onClick={openManageUsers}
                  className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900"
                >
                  <Users className="h-4 w-4" strokeWidth={2} />
                  Manage Users
                </button>
              )}
              <button
                type="button"
                onClick={logout}
                disabled={blockPortalFormForProcessing}
                className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400"
              >
                <LogOut className="h-4 w-4" strokeWidth={2} />
                Logout
              </button>
            </nav>

          </aside>
  );
}

