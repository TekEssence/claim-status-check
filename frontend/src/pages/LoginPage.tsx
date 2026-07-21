"use client";

import { motion } from "framer-motion";
import { useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowRight,
  Eye,
  EyeOff,
  Lock,
  ShieldCheck,
  Stethoscope,
  User,
} from "lucide-react";

const reveal = {
  hidden: { opacity: 0, y: 24 },
  visible: (delay = 0) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.72,
      delay,
      ease: [0.22, 1, 0.36, 1] as const,
    },
  }),
};

export function LoginPage() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState("");


  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setAuthError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Login failed.");
      }

      router.push("/portal");
      router.refresh();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative h-screen overflow-hidden bg-[#f3f8ff] text-slate-950">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.96)_0%,_rgba(239,246,255,0.96)_42%,_rgba(226,237,255,0.94)_100%)]" />
        <div className="absolute -top-24 right-[-10rem] h-[24rem] w-[24rem] rounded-full bg-[radial-gradient(circle,_rgba(37,99,235,0.92)_0%,_rgba(59,130,246,0.6)_38%,_rgba(59,130,246,0)_70%)] blur-xl" />
        <div className="absolute bottom-[-8rem] right-[10%] h-[20rem] w-[20rem] rounded-full bg-[radial-gradient(circle,_rgba(59,130,246,0.38)_0%,_rgba(59,130,246,0)_68%)]" />
        <div className="absolute left-[-5rem] top-[22%] h-[14rem] w-[14rem] rounded-full bg-[radial-gradient(circle,_rgba(220,242,255,0.92)_0%,_rgba(220,242,255,0)_72%)]" />
      </div>

      <div className="relative mx-auto flex h-screen max-w-[1600px] flex-col lg:flex-row">
        <section className="relative flex w-full flex-col px-6 pb-4 pt-4 sm:px-8 md:px-10 lg:w-[54%] lg:px-12 lg:pb-6 lg:pt-5 xl:px-16">
          <DecorativeMedicalLayer />

          <motion.div
            initial="hidden"
            animate="visible"
            variants={reveal}
            custom={0.05}
            className="relative z-10 flex items-center gap-3"
          >
            <div className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-sky-100 bg-white shadow-[0_16px_34px_rgba(37,99,235,0.18)]">
              <Image
                src="/opus-logo-2.jpg"
                alt="OPUS logo"
                fill
                className="object-contain p-1"
                sizes="56px"
                priority
              />
            </div>
            <div className="text-[1.75rem] font-extrabold tracking-[-0.04em] text-slate-900">
              Claim Status <span className="text-[#2563EB]">Portal</span>
            </div>
          </motion.div>

          <div className="relative z-10 flex flex-1 flex-col justify-center py-4 lg:py-5">
            <motion.div
              initial="hidden"
              animate="visible"
              variants={reveal}
              custom={0.12}
              className="inline-flex w-fit items-center gap-2 rounded-full border border-sky-200/80 bg-white/75 px-3 py-1.5 text-xs font-medium text-sky-700 shadow-[0_10px_25px_rgba(110,145,190,0.08)] backdrop-blur-sm sm:px-4 sm:py-2 sm:text-sm"
            >
              <ShieldCheck className="h-4 w-4" />
              HIPAA-aware claim operations
            </motion.div>

            <motion.h1
              initial="hidden"
              animate="visible"
              variants={reveal}
              custom={0.18}
              className="mt-5 max-w-[28rem] text-[2.25rem] font-extrabold leading-[0.9] tracking-[-0.06em] text-slate-950 sm:text-[2.85rem] lg:text-[3.55rem] xl:text-[3.9rem] [@media(max-height:820px)]:text-[3.2rem]"
            >
              <span className="text-[#2563EB]">Claim Status</span>
              <span className="mt-2 block text-slate-950">Automation</span>
            </motion.h1>

            <motion.p
              initial="hidden"
              animate="visible"
              variants={reveal}
              custom={0.24}
              className="mt-4 max-w-[28rem] text-[0.96rem] leading-6 text-slate-700 sm:text-base"
            >
              Access, track, and automate claim status across multiple healthcare portals with enterprise-level clarity, security, and speed.
            </motion.p>

            <motion.div
              initial="hidden"
              animate="visible"
              variants={reveal}
              custom={0.36}
              className="mt-6 grid gap-3 md:max-w-[30rem] md:grid-cols-2 [@media(max-height:820px)]:hidden"
            >
              <InfoCard
                icon={<Activity className="h-5 w-5" strokeWidth={2.1} />}
                title="Real-time monitoring"
                body="Track every portal touchpoint and claim milestone from one secure workspace."
              />
              <InfoCard
                icon={<ShieldCheck className="h-5 w-5" strokeWidth={2.1} />}
                title="Secure and compliant"
                body="Designed for authorized teams managing sensitive healthcare workflows."
              />
            </motion.div>
          </div>

          <motion.div
            initial="hidden"
            animate="visible"
            variants={reveal}
            custom={0.42}
            className="relative z-10 mt-4 flex items-end justify-between gap-4 rounded-[1.6rem] border border-white/70 bg-white/72 p-4 shadow-[0_20px_60px_rgba(114,141,183,0.12)] backdrop-blur-xl sm:p-5 [@media(max-height:820px)]:mt-3 [@media(max-height:820px)]:p-3.5"
          >
            <div className="max-w-[24rem]">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600 sm:text-sm">
                Secure | Reliable | Compliant
              </p>
              <p className="mt-2 text-sm leading-5 text-slate-600 sm:text-[0.95rem] [@media(max-height:820px)]:text-[0.82rem] [@media(max-height:820px)]:leading-4">
                Your data is protected with enterprise-grade authentication and role-based access controls.
              </p>
            </div>
            <div className="hidden h-12 w-12 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#e4fbf7_0%,#c7f0e8_100%)] text-emerald-600 shadow-inner sm:flex">
              <ShieldCheck className="h-5 w-5" strokeWidth={2.1} />
            </div>
          </motion.div>
        </section>

        <section className="relative flex w-full items-center justify-center px-6 pb-4 pt-2 sm:px-8 md:px-10 lg:w-[46%] lg:px-8 lg:py-4 xl:px-12">
          <motion.div
            initial={{ opacity: 0, x: 28, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            transition={{ duration: 0.78, ease: [0.22, 1, 0.36, 1] }}
            className="relative w-full max-w-[30rem] rounded-[1.8rem] border border-white/70 bg-white/78 p-5 shadow-[0_28px_80px_rgba(84,114,164,0.18)] backdrop-blur-2xl sm:p-6 lg:rounded-[2rem] lg:p-7 [@media(max-height:820px)]:max-w-[28rem] [@media(max-height:820px)]:p-5"
          >
            <div className="absolute inset-x-12 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(37,99,235,0.2),transparent)]" />

            <motion.div
              initial="hidden"
              animate="visible"
              variants={reveal}
              custom={0.12}
              className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.98),rgba(226,239,255,0.95)_72%)] text-[#2552c8] shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_18px_42px_rgba(117,149,196,0.16)] sm:h-24 sm:w-24"
            >
              <Stethoscope className="h-10 w-10 sm:h-12 sm:w-12" strokeWidth={1.9} />
            </motion.div>

            <motion.div
              initial="hidden"
              animate="visible"
              variants={reveal}
              custom={0.18}
              className="mt-3 text-center"
            >
              <h2 className="text-[1.8rem] font-bold tracking-[-0.05em] text-slate-950 sm:text-[2.15rem]">
                Welcome Back
              </h2>
              <p className="mt-2 text-sm text-slate-600 sm:text-base">
                Sign in to your account to continue
              </p>
            </motion.div>

            <motion.form
              initial="hidden"
              animate="visible"
              variants={reveal}
              custom={0.24}
              onSubmit={onSubmit}
              className="mt-6 space-y-4"
            >
              <InputField
                label="Username"
                placeholder="Enter your username"
                type="text"
                value={username}
                onChange={setUsername}
                icon={<User className="h-5 w-5" strokeWidth={2.1} />}
              />

              <InputField
                label="Password"
                placeholder="Enter your password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={setPassword}
                icon={<Lock className="h-5 w-5" strokeWidth={2.1} />}
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="text-slate-400 transition hover:text-[#2563EB]"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      <EyeOff className="h-5 w-5" strokeWidth={2.1} />
                    ) : (
                      <Eye className="h-5 w-5" strokeWidth={2.1} />
                    )}
                  </button>
                }
              />

              <div className="flex flex-col gap-4 text-sm text-slate-700 sm:flex-row sm:items-center sm:justify-between sm:text-base">
                <label className="inline-flex cursor-pointer items-center gap-3 font-medium">
                  <button
                    type="button"
                    onClick={() => setRememberMe((value) => !value)}
                    aria-pressed={rememberMe}
                    className={`flex h-5 w-5 items-center justify-center rounded-md border transition ${
                      rememberMe
                        ? "border-[#2563EB] bg-[#2563EB] text-white shadow-[0_8px_18px_rgba(37,99,235,0.22)]"
                        : "border-slate-300 bg-white text-transparent hover:border-[#2563EB]"
                    }`}
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
                      <path d="M6.4 11.2 3.3 8.1l-1 1 4.1 4.1 7.2-7.2-1-1z" />
                    </svg>
                  </button>
                  <span>Remember Me</span>
                </label>

                <button
                  type="button"
                  className="font-medium text-[#2563EB] transition hover:text-blue-700"
                >
                  Forgot password?
                </button>
              </div>

              {authError && (
                <div className="rounded-[1rem] border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                  {authError}
                </div>
              )}

              <motion.button
                whileHover={{ y: -2, scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                type="submit"
                disabled={submitting}
                className="flex h-12 w-full items-center justify-center gap-3 rounded-[1rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] text-base font-semibold text-white shadow-[0_18px_40px_rgba(37,99,235,0.28)] transition hover:shadow-[0_22px_46px_rgba(37,99,235,0.35)]"
              >
                <Lock className="h-5 w-5" strokeWidth={2.15} />
                {submitting ? "Signing In..." : "Sign In"}
                <ArrowRight className="h-5 w-5" strokeWidth={2.15} />
              </motion.button>
            </motion.form>

            <motion.div
              initial="hidden"
              animate="visible"
              variants={reveal}
              custom={0.3}
              className="mt-5 rounded-[1.2rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(243,248,255,0.95)_0%,rgba(233,242,255,0.92)_100%)] p-3.5 shadow-[0_14px_30px_rgba(128,153,189,0.12)] [@media(max-height:820px)]:hidden"
            >
              <div className="flex items-start gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#e2fbf7_0%,#c4f1e8_100%)] text-emerald-600">
                  <ShieldCheck className="h-4 w-4" strokeWidth={2.15} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900 sm:text-base">Secure Access</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600 sm:text-sm">
                    Authorized personnel only. Sessions are monitored and encrypted.
                  </p>
                </div>
              </div>
            </motion.div>

            <motion.p
              initial="hidden"
              animate="visible"
              variants={reveal}
              custom={0.34}
              className="mt-5 text-center text-xs text-slate-500 sm:text-sm"
            >
              Copyright 2026 Claim Status Portal. All rights reserved.
            </motion.p>
          </motion.div>
        </section>
      </div>
    </main>
  );
}

function InputField({
  label,
  placeholder,
  type,
  value,
  onChange,
  icon,
  trailing,
}: {
  label: string;
  placeholder: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-3 block text-[0.98rem] font-semibold text-slate-900">
        {label}
      </span>
      <div className="flex h-14 items-center gap-3 rounded-[1rem] border border-[#d5e3f4] bg-white/92 px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_10px_28px_rgba(187,203,226,0.08)] transition duration-200 hover:border-[#bfd3ee] focus-within:border-[#93c5fd] focus-within:shadow-[0_0_0_4px_rgba(37,99,235,0.08)]">
        <span className="text-slate-500">{icon}</span>
        <input
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-full flex-1 bg-transparent text-[1rem] text-slate-800 outline-none placeholder:text-slate-400"
        />
        {trailing}
      </div>
    </label>
  );
}

function InfoCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-[1.2rem] border border-white/70 bg-white/74 p-4 shadow-[0_16px_38px_rgba(124,149,186,0.1)] backdrop-blur-md">
      <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#eff6ff_0%,#dcecff_100%)] text-[#2563EB]">
        {icon}
      </div>
      <h3 className="mt-3 text-sm font-semibold text-slate-900 sm:text-base">{title}</h3>
      <p className="mt-1.5 text-xs leading-5 text-slate-600 sm:text-sm">{body}</p>
    </div>
  );
}

function DecorativeMedicalLayer() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        viewBox="0 0 600 600"
        className="absolute right-[8%] top-[10%] h-[19rem] w-[19rem] text-sky-100/90 lg:h-[24rem] lg:w-[24rem]"
        fill="none"
      >
        <path
          d="M225 68c67 58 72 117 14 179-62 66-72 121-26 179"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M295 82c-67 58-72 117-14 179 62 66 72 121 26 179"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path d="M236 118h48" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M228 165h64" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M220 214h80" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M225 262h72" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M238 310h48" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
      </svg>

      <svg
        viewBox="0 0 920 240"
        className="absolute bottom-[17%] left-[10%] h-[8rem] w-[60%] text-sky-200/80 lg:bottom-[19%] lg:h-[9rem]"
        fill="none"
      >
        <path
          d="M0 126h230l22-3 21-40 20 64 18-2 34-101 24 125 28-76 21 50 13-21 8 10h281"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <MedicalCross className="left-[50%] top-[18%]" />
      <MedicalCross className="left-[62%] top-[52%]" />

      <div className="absolute left-[56%] top-[15%] h-3 w-3 rounded-full bg-sky-200/80" />
      <div className="absolute left-[68%] top-[22%] h-4 w-4 rounded-full bg-sky-200/70" />
      <div className="absolute right-[18%] top-[28%] h-3 w-3 rounded-full bg-sky-200/80" />

      <svg
        viewBox="0 0 180 180"
        className="absolute left-[67%] top-[62%] h-20 w-20 text-sky-100/90"
        fill="none"
      >
        <path d="M90 26v24M90 130v24M35 58l21 12M124 110l21 12M35 122l21-12M124 70l21-12" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        <path d="M90 50 58 68v38l32 18 32-18V68z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
        <circle cx="90" cy="50" r="5" fill="currentColor" />
        <circle cx="58" cy="68" r="5" fill="currentColor" />
        <circle cx="58" cy="106" r="5" fill="currentColor" />
        <circle cx="90" cy="124" r="5" fill="currentColor" />
        <circle cx="122" cy="106" r="5" fill="currentColor" />
        <circle cx="122" cy="68" r="5" fill="currentColor" />
      </svg>
    </div>
  );
}

function MedicalCross({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={`absolute h-16 w-16 text-sky-100/95 lg:h-20 lg:w-20 ${className}`}
      fill="none"
    >
      <path
        d="M39 10h22v29h29v22H61v29H39V61H10V39h29z"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinejoin="round"
      />
    </svg>
  );
}








