import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound, Play } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

export function OptumProInputForm({
  canSubmit,
  inputFileName,
  isProcessing,
  loginFileName,
  onInputFileChange,
  onLoginFileChange,
  onSubmit,
}: {
  canSubmit: boolean;
  inputFileName?: string;
  isProcessing: boolean;
  loginFileName?: string;
  onInputFileChange: (file: File | null) => void;
  onLoginFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="rounded-[1.2rem] border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm text-blue-900">
        <span className="font-semibold">Required Columns:</span> One Healthcare ID or Email Address, Password, Medical Group Name, Patient, DOS, CPT, Member Id
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the One Healthcare ID workbook with username, password, and optional Login URL."
          fileName={loginFileName}
          icon={KeyRound}
          inputId="optumProLoginExcel"
          onFileSelect={onLoginFileChange}
          sizeHint="10 MB"
          title="Upload Login File"
        />
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the claim workbook with Optum Pro patient and service-line details."
          fileName={inputFileName}
          icon={FileSpreadsheet}
          inputId="optumProInputExcel"
          onFileSelect={onInputFileChange}
          sizeHint="25 MB"
          title="Upload Claim File"
        />
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex w-full items-center justify-center gap-2 rounded-[1.2rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(37,99,235,0.24)] transition hover:shadow-[0_22px_40px_rgba(37,99,235,0.32)] disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
      >
        <Play className="h-4 w-4" strokeWidth={2.2} />
        {isProcessing ? "Processing..." : "Start processing"}
      </button>
      <p className="text-center text-sm text-slate-500">Output Excel downloads automatically after completion or stop.</p>
    </form>
  );
}
