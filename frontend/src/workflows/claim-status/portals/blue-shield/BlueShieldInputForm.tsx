import type { FormEvent } from "react";
import { FileSpreadsheet, Info, KeyRound, Play } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

export function BlueShieldInputForm({
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
      <div className="flex gap-3 rounded-[1.2rem] border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        Groups are detected automatically from the claim workbook and matched to the login workbook.
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the credential workbook containing Group, URL, User Name, and Password."
          fileName={credentialFileName}
          icon={KeyRound}
          inputId="blueShieldCredentialExcel"
          onFileSelect={onCredentialFileChange}
          sizeHint="10 MB"
          title="Upload Login File"
        />
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the claim workbook containing Group, Member ID, and DOS columns."
          fileName={inputFileName}
          icon={FileSpreadsheet}
          inputId="blueShieldInputExcel"
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
      <p className="text-center text-sm text-slate-500">Estimated processing time: 2-5 minutes</p>
    </form>
  );
}
