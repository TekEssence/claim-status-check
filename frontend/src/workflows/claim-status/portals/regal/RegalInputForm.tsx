import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound, Play } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

export function RegalInputForm({
  canSubmit,
  claimFileName,
  isProcessing,
  loginFileName,
  onClaimFileChange,
  onLoginFileChange,
  onSubmit,
}: {
  canSubmit: boolean;
  claimFileName?: string;
  isProcessing: boolean;
  loginFileName?: string;
  onClaimFileChange: (file: File | null) => void;
  onLoginFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload a login workbook if you want to override the secure environment credentials."
          fileName={loginFileName}
          helperText="Optional. Leave this empty to continue with the configured Regal credentials."
          icon={KeyRound}
          inputId="regalLoginExcel"
          onFileSelect={onLoginFileChange}
          optional
          sizeHint="10 MB"
          title="Upload Login File"
        />
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the Regal claim workbook containing Group, Member Name, and DOS details."
          fileName={claimFileName}
          helperText="Supported groups: IPHS, IPPS, and IPPCS."
          icon={FileSpreadsheet}
          inputId="regalClaimExcel"
          onFileSelect={onClaimFileChange}
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
        {isProcessing ? "Processing..." : "Start Regal search"}
      </button>
      <p className="text-center text-sm text-slate-500">Estimated processing time: 2-5 minutes</p>
    </form>
  );
}
