"use client";

import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

type PaymentEobInputFormProps = {
  portalName?: string;
  credentialFileName?: string;
  referenceFileName?: string;
  requiresReferenceExcel?: boolean;
  showReferenceExcel?: boolean;
  showProjectSelection?: boolean;
  selectedProject?: "charm" | "medrevenue" | "";
  isRunning: boolean;
  canStart: boolean;
  onCredentialFileChange: (file: File | null) => void;
  onReferenceFileChange: (file: File | null) => void;
  onProjectChange?: (project: "charm" | "medrevenue") => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function PaymentEobInputForm({
  portalName = "Availity",
  credentialFileName,
  referenceFileName,
  requiresReferenceExcel = true,
  showReferenceExcel = requiresReferenceExcel,
  showProjectSelection = false,
  selectedProject = "",
  isRunning,
  canStart,
  onCredentialFileChange,
  onReferenceFileChange,
  onProjectChange,
  onSubmit,
}: PaymentEobInputFormProps) {
  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      {showProjectSelection ? (
        <div className="rounded-[1.2rem] border border-sky-100 bg-white/90 p-4">
          <p className="text-sm font-semibold text-slate-900">Select Project</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {([
              { id: "medrevenue" as const, name: "MedRevenue", description: "Processes pending EFTs and performs the zero-payment comparison." },
              { id: "charm" as const, name: "Charm", description: "Runs the existing Charm remittance comparison and EOB download flow." },
            ]).map((project) => {
              const isSelected = selectedProject === project.id;
              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => onProjectChange?.(project.id)}
                  disabled={isRunning}
                  className={`rounded-[1rem] border px-4 py-3 text-left transition ${isSelected ? "border-blue-400 bg-blue-50 text-blue-950 shadow-[0_12px_24px_rgba(37,99,235,0.12)]" : "border-sky-100 bg-slate-50/70 text-slate-700 hover:border-blue-200 hover:bg-blue-50/60"} disabled:cursor-not-allowed disabled:opacity-70`}
                >
                  <span className="block text-sm font-semibold">{project.name}</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">{project.description}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className={`grid gap-4 ${showReferenceExcel ? "md:grid-cols-2" : ""}`}>
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description={`Upload the workbook containing ${portalName} credential details.`}
          fileName={credentialFileName}
          icon={KeyRound}
          inputId="paymentEobCredentialExcel"
          onFileSelect={onCredentialFileChange}
          sizeHint="25 MB"
          title="Upload Credential Excel"
        />
        {showReferenceExcel ? (
          <PortalUploadCard
            mode="file"
            accept=".xlsx,.xls,.csv"
            acceptedFormats=".xlsx, .xls, .csv"
            description={requiresReferenceExcel
              ? "Upload the reference workbook containing Check, EFT, or FD numbers to compare."
              : "Optional. Required only for clients using the Cash Log and Zero Payments process."}
            fileName={referenceFileName}
            icon={FileSpreadsheet}
            inputId="paymentEobReferenceExcel"
            onFileSelect={onReferenceFileChange}
            sizeHint="25 MB"
            title={requiresReferenceExcel ? "Upload Reference Excel" : "Upload Control Log (if required)"}
          />
        ) : null}
      </div>

      <button
        type="submit"
        disabled={!canStart}
        className="inline-flex w-full items-center justify-center rounded-[1rem] bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {isRunning ? "Running..." : "Start Job"}
      </button>
    </form>
  );
}
