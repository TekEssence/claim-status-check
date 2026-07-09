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
    description: "Verify claim status across IEHP, Aerial, Regal, Blue Shield, and Availity.",
    route: "/claim-status",
    icon: FileSearch,
    iconClassName: "bg-blue-100 text-blue-700",
  },
  {
    id: "eligibility-verification",
    name: "Eligibility Verification",
    description: "Verify member eligibility through Waystar and future eligibility portals.",
    route: "/eligibility",
    icon: HeartPulse,
    iconClassName: "bg-emerald-100 text-emerald-700",
  },
] as const;

export function WorkflowDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f4f7fb]">
        <LoaderCircle className="h-7 w-7 animate-spin text-blue-600" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f4f7fb] text-slate-900">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="relative h-11 w-11 overflow-hidden rounded-md border border-slate-200">
              <Image src="/opus-logo-2.jpg" alt="OPUS" fill sizes="44px" className="object-contain p-1" />
            </span>
            <span>
              <span className="block text-sm font-semibold">Healthcare Automation</span>
              <span className="block text-xs text-slate-500">{user.email || user.username}</span>
            </span>
          </div>
          <button
            type="button"
            onClick={logout}
            title="Logout"
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="hidden min-h-[calc(100vh-8rem)] flex-col border-r border-slate-200 pr-5 lg:flex">
          <div className="flex items-center gap-3 rounded-md bg-blue-50 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-600 text-white">
              <Stethoscope className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold">Automation Portal</span>
              <span className="block text-xs text-slate-500">Healthcare workflows</span>
            </span>
          </div>

          <nav className="mt-6 space-y-1">
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-md bg-blue-50 px-3 py-2.5 text-left text-sm font-semibold text-blue-700"
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => router.push("/claim-status?view=reset-password")}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-slate-600 hover:bg-white hover:text-slate-900"
            >
              <ShieldEllipsis className="h-4 w-4" />
              Reset Password
            </button>
            {user.role === "ADMIN" && (
              <button
                type="button"
                onClick={() => router.push("/claim-status?view=manage-users")}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-slate-600 hover:bg-white hover:text-slate-900"
              >
                <Users className="h-4 w-4" />
                Manage Users
              </button>
            )}
            <button
              type="button"
              onClick={logout}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-slate-600 hover:bg-white hover:text-slate-900"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </nav>
        </aside>

        <section className="min-w-0">
          <div className="border-b border-slate-200 pb-6">
            <p className="text-xs font-semibold uppercase text-blue-600">Dashboard</p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-950">Choose a workflow</h1>
            <p className="mt-2 text-sm text-slate-600">Select the healthcare automation you want to run.</p>
          </div>

          <div className="mt-7 grid gap-5 md:grid-cols-2">
            {workflows.map((workflow) => {
              const Icon = workflow.icon;
              return (
                <button
                  key={workflow.id}
                  type="button"
                  onClick={() => router.push(workflow.route)}
                  className="group flex min-h-52 flex-col border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:border-blue-400 hover:shadow-md"
                >
                  <span className={`flex h-11 w-11 items-center justify-center rounded-md ${workflow.iconClassName}`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <h2 className="mt-5 text-xl font-semibold">{workflow.name}</h2>
                  <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{workflow.description}</p>
                  <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-blue-700">
                    Open workflow
                    <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
