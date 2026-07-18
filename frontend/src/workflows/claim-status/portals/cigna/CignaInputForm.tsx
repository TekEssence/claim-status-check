import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound, Play } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

export function CignaInputForm({
  canSubmit,
  credentialFileName,
  inputFileName,
  isProcessing,
  onCredentialFileChange,
  onInputFileChange,
  onSubmit,
}: {
  canSubmit: boolean;
  credentialFileName?: string;
  inputFileName?: string;
  isProcessing: boolean;
  onCredentialFileChange: (file: File | null) => void;
  onInputFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="rounded-[1.2rem] border border-sky-100 bg-sky-50/70 px-4 py-3 text-sm text-sky-900">
        <span className="font-semibold">Required claim columns:</span> Member ID or Cigna Patient ID, First Name, Last Name, and CPT.
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the workbook containing URL, User ID, and Password for Cigna for Health Care Professionals."
          fileName={credentialFileName}
          icon={KeyRound}
          inputId="cignaCredentialExcel"
          onFileSelect={onCredentialFileChange}
          sizeHint="10 MB"
          title="Upload Login File"
        />
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the claim workbook with Cigna Patient ID, patient name, DOS, and CPT columns."
          fileName={inputFileName}
          icon={FileSpreadsheet}
          inputId="cignaInputExcel"
          onFileSelect={onInputFileChange}
          sizeHint="25 MB"
          title="Upload Claim File"
        />
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex w-full items-center justify-center gap-2 rounded-[1.2rem] bg-[linear-gradient(90deg,#0033ff_0%,#0439d8_48%,#071f8f_100%)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(37,99,235,0.24)] transition hover:shadow-[0_22px_40px_rgba(37,99,235,0.32)] disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
      >
        <Play className="h-4 w-4" strokeWidth={2.2} />
        {isProcessing ? "Processing..." : "Start processing"}
      </button>
      <p className="text-center text-sm text-slate-500">If Cigna asks for email verification, enter the code here when prompted.</p>
    </form>
  );
}
