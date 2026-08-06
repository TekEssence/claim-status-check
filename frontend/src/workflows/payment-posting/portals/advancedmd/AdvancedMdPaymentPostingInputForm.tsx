"use client";

import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound, ShieldCheck } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

type AdvancedMdPaymentPostingInputFormProps = {
  credentialFileName?: string;
  inputFileName?: string;
  isRunning: boolean;
  canStart: boolean;
  onCredentialFileChange: (file: File | null) => void;
  onInputFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function AdvancedMdPaymentPostingInputForm({
  credentialFileName,
  inputFileName,
  isRunning,
  canStart,
  onCredentialFileChange,
  onInputFileChange,
  onSubmit,
}: AdvancedMdPaymentPostingInputFormProps) {
  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
        <span className="inline-flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          Dry Run - Nothing Will Be Posted
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls"
          acceptedFormats=".xlsx, .xls"
          description="Upload the workbook containing AdvancedMD login credentials."
          fileName={credentialFileName}
          icon={KeyRound}
          inputId="advancedMdPaymentPostingCredentialExcel"
          onFileSelect={onCredentialFileChange}
          sizeHint="25 MB"
          title="Upload Credential Excel"
        />
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls"
          acceptedFormats=".xlsx, .xls"
          description="Upload the payment posting workbook containing check, patient, claim, CPT, charge, and payment rows."
          fileName={inputFileName}
          icon={FileSpreadsheet}
          inputId="advancedMdPaymentPostingInputExcel"
          onFileSelect={onInputFileChange}
          sizeHint="25 MB"
          title="Upload Payment Posting Excel"
        />
      </div>

      <button
        type="submit"
        disabled={!canStart}
        className="inline-flex w-full items-center justify-center rounded-[1rem] bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {isRunning ? "Running..." : "Validate Dry Run"}
      </button>
    </form>
  );
}

