"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  FileSearch,
  HeartPulse,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  ShieldEllipsis,
  Stethoscope,
  Users,
} from "lucide-react";

type AuthUser = {
  username: string;
  email: string;
  role: "ADMIN" | "USER";
  mustResetPassword: boolean;
};

const workflows = [
  {
    id: "claim-status",
    name: "Claim Status",
    description: "Verify claim status across IEHP, Aerial, Regal, Blue Shield, Availity, Waystar, Optum Pro, and Medpoint.",
    route: "/claim-status",
    icon: FileSearch,
    iconClassName: "bg-blue-100 text-blue-700",
    accentClassName: "from-[#eff6ff] via-white to-[#dbeafe]",
    badgeClassName: "border-blue-200 bg-blue-100/80 text-blue-700",
    glowClassName: "bg-[radial-gradient(circle_at_top_right,_rgba(59,130,246,0.22),_transparent_58%)]",
  },
  {
    id: "eligibility-verification",
    name: "Eligibility Verification",
    description: "Verify member eligibility through Waystar and future eligibility portals.",
    route: "/eligibility",
    icon: HeartPulse,
    iconClassName: "bg-emerald-100 text-emerald-700",
    accentClassName: "from-[#ecfdf5] via-white to-[#d1fae5]",
    badgeClassName: "border-emerald-200 bg-emerald-100/80 text-emerald-700",
    glowClassName: "bg-[radial-gradient(circle_at_top_right,_rgba(16,185,129,0.2),_transparent_58%)]",
  },
] as const;

export function WorkflowDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [workflowNotice, setWorkflowNotice] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me")
      .then(async (response) => {
        if (!response.ok) throw new Error("Authentication required.");
        return response.json() as Promise<{ user: AuthUser }>;
      })
      .then(({ user: nextUser }) => {
        if (!active) return;
        if (nextUser.mustResetPassword) {
          router.replace("/claim-status");
          return;
        }
        setUser(nextUser);
      })
      .catch(() => router.replace("/"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [router]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/");
  }

  function handleWorkflowSelect(route: string) {
    setWorkflowNotice("");
    router.push(route);
  }

  if (loading || !user) {
    return (
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.16),transparent_34%),linear-gradient(160deg,#f7fbff_0%,#edf4ff_50%,#f8fafc_100%)]">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[size:36px_36px] opacity-40" />
        <div className="relative rounded-full border border-white/70 bg-white/70 p-5 shadow-[0_22px_65px_rgba(37,99,235,0.14)] backdrop-blur">
          <LoaderCircle className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      </main>
    );
  }

  const userIdentity = user.email || user.username;
  const userName = userIdentity.split("@")[0].replace(/[._-]+/g, " ").trim() || "Team Member";
  const displayName = userName
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
  const initials = displayName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "HA";

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(14,116,144,0.12),transparent_28%),radial-gradient(circle_at_top_right,_rgba(37,99,235,0.13),transparent_30%),linear-gradient(160deg,#f7fbff_0%,#eef5ff_44%,#f8fbff_100%)] text-slate-900">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.07)_1px,transparent_1px)] bg-[size:38px_38px] opacity-35" />
      <div className="pointer-events-none absolute -left-20 top-24 h-64 w-64 rounded-full bg-[radial-gradient(circle,_rgba(59,130,246,0.18)_0%,_rgba(59,130,246,0)_72%)] blur-2xl" />
      <div className="pointer-events-none absolute right-0 top-0 h-80 w-80 rounded-full bg-[radial-gradient(circle,_rgba(14,165,233,0.16)_0%,_rgba(14,165,233,0)_72%)] blur-3xl" />

      <header className="relative border-b border-white/70 bg-white/78 px-4 py-4 shadow-[0_18px_40px_rgba(148,163,184,0.12)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="relative flex h-14 w-14 overflow-hidden rounded-2xl border border-sky-100 bg-white shadow-[0_16px_36px_rgba(37,99,235,0.16)]">
              <Image src="/opus-logo-2.jpg" alt="OPUS" fill sizes="56px" className="object-contain p-2" />
            </span>
            <div>
              <p className="text-base font-semibold tracking-[-0.02em] text-slate-950">Healthcare Automation</p>
              <p className="mt-1 text-sm text-slate-500">Command center for claim status and eligibility workflows</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden rounded-2xl border border-white/80 bg-white/80 px-4 py-2 text-right shadow-[0_12px_30px_rgba(148,163,184,0.12)] sm:block">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600">Signed In</p>
              <p className="mt-1 text-sm font-medium text-slate-700">{userIdentity}</p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#2563eb_0%,#0ea5e9_100%)] text-sm font-semibold text-white shadow-[0_12px_28px_rgba(37,99,235,0.28)]">
              {initials}
            </div>
            <button
              type="button"
              onClick={logout}
              title="Logout"
              className="rounded-2xl border border-white/80 bg-white/80 p-3 text-slate-500 shadow-[0_12px_30px_rgba(148,163,184,0.12)] transition hover:-translate-y-0.5 hover:text-slate-900"
            >
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="relative mx-auto grid w-full max-w-7xl gap-6 px-4 py-8 lg:grid-cols-[290px_minmax(0,1fr)] xl:gap-8">
        <aside className="hidden min-h-[calc(100vh-10rem)] overflow-hidden rounded-[2rem] border border-white/80 bg-white/72 p-5 shadow-[0_30px_80px_rgba(148,163,184,0.16)] backdrop-blur-xl lg:flex lg:flex-col">
          <div className="rounded-[1.6rem] bg-[linear-gradient(145deg,#0f172a_0%,#1d4ed8_58%,#38bdf8_100%)] p-5 text-white shadow-[0_24px_60px_rgba(37,99,235,0.28)]">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/16 backdrop-blur">
                <Stethoscope className="h-6 w-6" />
              </span>
              <div>
                <p className="text-base font-semibold">Automation Portal</p>
                <p className="text-sm text-blue-100/85">Healthcare workflows</p>
              </div>
            </div>
            <div className="mt-5 rounded-[1.25rem] border border-white/14 bg-white/10 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.22em] text-blue-100/80">Welcome</p>
              <p className="mt-2 text-lg font-semibold">{displayName}</p>
              <p className="mt-1 text-sm text-blue-100/80">Choose the workflow you want to open and continue from one place.</p>
            </div>
          </div>

          <nav className="mt-6 space-y-2">
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-[1.2rem] bg-[linear-gradient(90deg,rgba(37,99,235,0.14)_0%,rgba(14,165,233,0.08)_100%)] px-4 py-3 text-left text-sm font-semibold text-blue-700"
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => router.push("/claim-status?view=reset-password")}
              className="flex w-full items-center gap-3 rounded-[1.2rem] px-4 py-3 text-left text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-900"
            >
              <ShieldEllipsis className="h-4 w-4" />
              Reset Password
            </button>
            {user.role === "ADMIN" && (
              <button
                type="button"
                onClick={() => router.push("/claim-status?view=manage-users")}
                className="flex w-full items-center gap-3 rounded-[1.2rem] px-4 py-3 text-left text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-900"
              >
                <Users className="h-4 w-4" />
                Manage Users
              </button>
            )}
            <button
              type="button"
              onClick={logout}
              className="flex w-full items-center gap-3 rounded-[1.2rem] px-4 py-3 text-left text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-900"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </nav>

          <div className="mt-auto rounded-[1.5rem] border border-sky-100 bg-[linear-gradient(145deg,#ffffff_0%,#eff6ff_100%)] p-4 shadow-[0_18px_44px_rgba(148,163,184,0.12)]">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-600">Portal Snapshot</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white px-3 py-3 shadow-sm">
                <p className="text-[0.7rem] uppercase tracking-[0.18em] text-slate-400">Workflows</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{workflows.length}</p>
              </div>
              <div className="rounded-2xl bg-white px-3 py-3 shadow-sm">
                <p className="text-[0.7rem] uppercase tracking-[0.18em] text-slate-400">Role</p>
                <p className="mt-2 text-sm font-semibold text-slate-950">{user.role === "ADMIN" ? "Admin" : "User"}</p>
              </div>
            </div>
          </div>
        </aside>

        <section className="min-w-0">
          <div className="overflow-hidden rounded-[2rem] border border-white/80 bg-white/70 p-6 shadow-[0_30px_80px_rgba(148,163,184,0.16)] backdrop-blur-xl md:p-8">
            <div className="relative overflow-hidden rounded-[1.8rem] bg-[linear-gradient(135deg,#0f172a_0%,#1d4ed8_46%,#38bdf8_100%)] px-6 py-7 text-white shadow-[0_24px_60px_rgba(37,99,235,0.24)] md:px-8 md:py-8">
              <div className="pointer-events-none absolute -right-16 top-0 h-44 w-44 rounded-full bg-white/12 blur-2xl" />
              <div className="pointer-events-none absolute bottom-0 right-10 h-24 w-24 rounded-full border border-white/20" />
              <div className="relative flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
                <div className="max-w-2xl">
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-blue-100/85">Dashboard</p>
                  <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-white md:text-5xl">Choose a workflow</h1>
                  <p className="mt-4 max-w-xl text-sm leading-6 text-blue-100/90 md:text-base">
                    Launch the healthcare automation you need from a clearer, more focused workspace designed for daily operations.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:max-w-xs">
                  <div className="rounded-2xl border border-white/18 bg-white/10 px-4 py-4 backdrop-blur">
                    <p className="text-[0.68rem] uppercase tracking-[0.22em] text-blue-100/78">Available</p>
                    <p className="mt-2 text-2xl font-semibold text-white">{workflows.length}</p>
                  </div>
                  <div className="rounded-2xl border border-white/18 bg-white/10 px-4 py-4 backdrop-blur">
                    <p className="text-[0.68rem] uppercase tracking-[0.22em] text-blue-100/78">Profile</p>
                    <p className="mt-2 text-sm font-semibold text-white">{user.role === "ADMIN" ? "Administrator" : "Standard User"}</p>
                  </div>
                </div>
              </div>
            </div>

            {workflowNotice ? (
              <div className="mt-6 rounded-[1.4rem] border border-amber-200 bg-[linear-gradient(135deg,#fff9eb_0%,#fff4d6_100%)] px-5 py-4 text-sm font-medium text-amber-900 shadow-[0_18px_40px_rgba(245,158,11,0.12)]">
                {workflowNotice}
              </div>
            ) : null}

            <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-600">Workflows</p>
                <p className="mt-2 text-sm text-slate-600">Select the healthcare automation you want to run.</p>
              </div>
              <div className="rounded-full border border-sky-100 bg-sky-50/80 px-4 py-2 text-sm font-medium text-sky-700">
                Signed in as {displayName}
              </div>
            </div>

            <div className="mt-6 grid gap-5 xl:grid-cols-2">
              {workflows.map((workflow) => {
                const Icon = workflow.icon;
                return (
                  <button
                    key={workflow.id}
                    type="button"
                    onClick={() => handleWorkflowSelect(workflow.route)}
                    className={`group relative overflow-hidden rounded-[1.8rem] border border-slate-200/80 bg-gradient-to-br ${workflow.accentClassName} p-6 text-left shadow-[0_22px_55px_rgba(148,163,184,0.14)] transition duration-200 hover:-translate-y-1 hover:border-sky-200 hover:shadow-[0_30px_70px_rgba(37,99,235,0.16)] md:p-7`}
                  >
                    <div className={`pointer-events-none absolute inset-0 opacity-80 ${workflow.glowClassName}`} />
                    <div className="relative flex h-full flex-col">
                      <div className="flex items-start justify-between gap-4">
                        <span className={`flex h-12 w-12 items-center justify-center rounded-2xl shadow-sm ${workflow.iconClassName}`}>
                          <Icon className="h-5 w-5" />
                        </span>
                        <span className={`rounded-full border px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.18em] ${workflow.badgeClassName}`}>
                          Workflow
                        </span>
                      </div>
                      <h2 className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-slate-950">{workflow.name}</h2>
                      <p className="mt-3 flex-1 text-sm leading-7 text-slate-600">{workflow.description}</p>
                      <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-blue-700">
                        Open workflow
                        <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
