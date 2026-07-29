"use client";

import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

type PaymentEobInputFormProps = {
  portalName?: string;
  credentialFileName?: string;
  referenceFileName?: string;
  isRunning: boolean;
  canStart: boolean;
  onCredentialFileChange: (file: File | null) => void;
  onReferenceFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function PaymentEobInputForm({
  portalName = "Availity",
  credentialFileName,
  referenceFileName,
  isRunning,
  canStart,
  onCredentialFileChange,
  onReferenceFileChange,
  onSubmit,
}: PaymentEobInputFormProps) {
  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="grid gap-4 md:grid-cols-2">
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
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the reference workbook containing Check, EFT, or FD numbers to compare."
          fileName={referenceFileName}
          icon={FileSpreadsheet}
          inputId="paymentEobReferenceExcel"
          onFileSelect={onReferenceFileChange}
          sizeHint="25 MB"
          title="Upload Reference Excel"
        />
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
