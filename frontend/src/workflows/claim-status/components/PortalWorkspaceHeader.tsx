import { motion } from "framer-motion";
import Image from "next/image";
import type { ReactNode } from "react";
import dashboardWelcomeImage from "../../../Assets/ChatGPT Image Jul 1, 2026, 10_55_01 AM.png";
import type { PORTAL_UI_META } from "../portal-meta";

type PortalUiMeta = (typeof PORTAL_UI_META)[keyof typeof PORTAL_UI_META];

export function PortalWorkspaceHeader(p: {
  portalName: string; portalUiMeta: PortalUiMeta | null;
  steps: string[]; stepIndex: number; workflowRunsPanel: ReactNode;
}) {
  const selectedPortal = { name: p.portalName };
  const selectedPortalUiMeta = p.portalUiMeta;
  const portalWorkflowSteps = p.steps;
  const portalWorkflowStepIndex = p.stepIndex;
  const workflowRunsPanel = p.workflowRunsPanel;
  return (
    <>
<motion.div
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45 }}
                className="relative overflow-hidden rounded-[1.6rem] border border-sky-100 bg-[linear-gradient(135deg,rgba(239,246,255,0.96)_0%,rgba(221,235,255,0.84)_55%,rgba(255,255,255,0.96)_100%)] p-5 shadow-[0_18px_40px_rgba(148,163,184,0.12)]"
              >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-center">
                  <div className="max-w-xl">
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={`flex items-center justify-center overflow-hidden text-sm font-semibold shadow-inner ${
                          selectedPortalUiMeta?.logoSrc
                            ? (selectedPortalUiMeta.heroLogoFrameClassName ?? "h-12 w-[5.6rem] rounded-[1rem] px-2.5")
                            : "h-12 w-12 rounded-[1rem]"
                        } ${selectedPortalUiMeta?.logoClassName ?? "bg-blue-50 text-blue-700"}`}
                      >
                        {selectedPortalUiMeta?.logoSrc ? (
                          <Image
                            src={selectedPortalUiMeta.logoSrc}
                            alt={`${selectedPortal.name} logo`}
                            width={selectedPortalUiMeta.heroLogoSize?.width ?? 84}
                            height={selectedPortalUiMeta.heroLogoSize?.height ?? 28}
                            className={selectedPortalUiMeta.heroLogoImageClassName ?? "h-6 w-full object-contain"}
                          />
                        ) : (
                          selectedPortalUiMeta?.shortCode ?? "PRT"
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[0.72rem] font-semibold text-emerald-600">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Ready
                      </span>
                    </div>
                    <h1 className="mt-4 text-[1.8rem] font-semibold tracking-[-0.05em] text-slate-950">{selectedPortal.name}</h1>
                  </div>

                  <div className="relative hidden h-[12rem] overflow-hidden rounded-[1.2rem] border border-sky-100/80 bg-white/55 shadow-[0_14px_28px_rgba(59,130,246,0.1)] lg:block">
                    <Image
                      src={dashboardWelcomeImage}
                      alt="Healthcare workflow illustration"
                      fill
                      className="object-cover object-center opacity-100 scale-[0.92]"
                    />
                    <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(244,248,255,0.02)_0%,rgba(244,248,255,0)_28%,rgba(244,248,255,0.12)_100%)]" />
                  </div>
                </div>
              </motion.div>

              <div className="mt-5 rounded-[1.5rem] border border-sky-100 bg-white/88 p-5 shadow-[0_16px_34px_rgba(148,163,184,0.1)]">
                <div className="flex flex-wrap items-center gap-3 md:flex-nowrap">
                  {portalWorkflowSteps.map((step, index) => {
                    const isActive = index === portalWorkflowStepIndex;
                    const isComplete = index < portalWorkflowStepIndex;

                    return (
                      <div key={step} className="flex min-w-0 flex-1 items-center gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                          isComplete
                            ? "bg-emerald-100 text-emerald-700"
                            : isActive
                              ? "bg-[linear-gradient(135deg,#2563eb_0%,#3b82f6_100%)] text-white shadow-[0_12px_24px_rgba(37,99,235,0.24)]"
                              : "bg-sky-50 text-slate-500"
                        }`}>
                          {index + 1}
                        </div>
                        <div className="min-w-0">
                          <p className={`truncate text-sm font-medium ${isActive || isComplete ? "text-slate-900" : "text-slate-500"}`}>{step}</p>
                        </div>
                        {index < portalWorkflowSteps.length - 1 ? (
                          <div className={`hidden h-px flex-1 md:block ${isComplete ? "bg-emerald-300" : "bg-sky-100"}`} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              {workflowRunsPanel}
    </>
  );
}

