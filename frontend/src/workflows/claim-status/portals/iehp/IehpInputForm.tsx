import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound, Play } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

export function IehpInputForm({
  canSubmit,
  claimFileName,
  loginFileName,
  isProcessing,
  isResumePending,
  onClaimFileChange,
  onLoginFileChange,
  onSelectClaimFile,
  onSubmit,
}: {
  canSubmit: boolean;
  claimFileName: string;
  loginFileName?: string;
  isProcessing: boolean;
  isResumePending?: boolean;
  onClaimFileChange?: (file: File | null) => void;
  onLoginFileChange: (file: File | null) => void;
  onSelectClaimFile?: () => unknown;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the IEHP login workbook to begin the secure claim status automation flow."
          fileName={loginFileName}
          icon={KeyRound}
          inputId="loginExcel"
          onFileSelect={onLoginFileChange}
          sizeHint="10 MB"
          title="Upload Login File"
        />
        {onClaimFileChange ? (
          <PortalUploadCard
            mode="file"
            accept=".xlsx,.xls"
            acceptedFormats=".xlsx, .xls"
            description="Upload the IEHP claims workbook. Results are generated as downloadable output files without writing back to your local file."
            fileName={claimFileName}
            helperText="The original workbook is read only once and is never updated in place."
            icon={FileSpreadsheet}
            inputId="iehpClaimExcel"
            onFileSelect={onClaimFileChange}
            sizeHint="25 MB"
            title="Upload Claim File"
          />
        ) : (
          <PortalUploadCard
            mode="action"
            acceptedFormats=".xlsx, .xls"
            actionLabel="Select Claim File"
            description="Choose the exact claims workbook that will be updated in place as processing continues."
            fileName={claimFileName}
            helperText="Browser file-system access keeps the workbook linked for live write-back updates."
            icon={FileSpreadsheet}
            onAction={() => void onSelectClaimFile?.()}
            sizeHint="25 MB"
            title="Upload Claim File"
          />
        )}
      </div>
      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex w-full items-center justify-center gap-2 rounded-[1.2rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(37,99,235,0.24)] transition hover:shadow-[0_22px_40px_rgba(37,99,235,0.32)] disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
      >
        <Play className="h-4 w-4" strokeWidth={2.2} />
        {isProcessing ? "Processing..." : isResumePending ? "Allow And Continue" : "Start processing"}
      </button>
    </form>
  );
}

