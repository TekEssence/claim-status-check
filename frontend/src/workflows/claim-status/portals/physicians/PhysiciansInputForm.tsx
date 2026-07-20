import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound, Play } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

export function PhysiciansInputForm({
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
      <div className="rounded-[1.2rem] border border-orange-100 bg-orange-50/70 px-4 py-3 text-sm text-orange-950">
        <span className="font-semibold">Required claim columns:</span> Member ID and DOS. Optional columns include CPT, Authorization #, and Provider Claim/Patient Account #.
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the workbook containing URL, User ID, and Password for the PHN QuickCap portal."
          fileName={credentialFileName}
          icon={KeyRound}
          inputId="physiciansCredentialExcel"
          onFileSelect={onCredentialFileChange}
          sizeHint="10 MB"
          title="Upload Login File"
        />
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the claim workbook with Member ID, DOS, and optional claim filters."
          fileName={inputFileName}
          icon={FileSpreadsheet}
          inputId="physiciansInputExcel"
          onFileSelect={onInputFileChange}
          sizeHint="25 MB"
          title="Upload Claim File"
        />
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex w-full items-center justify-center gap-2 rounded-[1.2rem] bg-[linear-gradient(90deg,#e97100_0%,#ea580c_52%,#b45309_100%)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(234,88,12,0.22)] transition hover:shadow-[0_22px_40px_rgba(234,88,12,0.3)] disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
      >
        <Play className="h-4 w-4" strokeWidth={2.2} />
        {isProcessing ? "Processing..." : "Start processing"}
      </button>
      <p className="text-center text-sm text-slate-500">Output Excel and run log download automatically after completion or stop.</p>
    </form>
  );
}
