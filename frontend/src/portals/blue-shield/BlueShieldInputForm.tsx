import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound, Play } from "lucide-react";
import { PortalUploadCard } from "../../components/portal-workflow/PortalUploadCard";

export function BlueShieldInputForm({
  canSubmit,
  credentialFileName,
  group,
  inputFileName,
  isProcessing,
  resetCheckpoint,
  onCredentialFileChange,
  onGroupChange,
  onInputFileChange,
  onResetCheckpointChange,
  onSubmit,
}: {
  canSubmit: boolean;
  credentialFileName?: string;
  group: string;
  inputFileName?: string;
  isProcessing: boolean;
  resetCheckpoint: boolean;
  onCredentialFileChange: (file: File | null) => void;
  onGroupChange: (group: string) => void;
  onInputFileChange: (file: File | null) => void;
  onResetCheckpointChange: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="rounded-[1.5rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(244,249,255,0.96)_100%)] p-5 shadow-[0_16px_34px_rgba(148,163,184,0.12)]">
        <label className="text-base font-semibold tracking-[-0.03em] text-slate-950" htmlFor="blueShieldGroup">
          Select Processing Group
        </label>
        <p className="mt-2 text-sm text-slate-600">Choose the Blue Shield payer group before uploading the workbook package.</p>
        <select
          id="blueShieldGroup"
          value={group}
          onChange={(event) => onGroupChange(event.target.value)}
          className="mt-4 block w-full rounded-[1rem] border border-sky-100 bg-white/90 px-4 py-3 text-sm text-slate-800 shadow-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100/60"
        >
          <option value="" disabled>
            Select group
          </option>
          <option value="IUMG">IUMG</option>
          <option value="IPMG">IPMG</option>
          <option value="Posada">Posada</option>
        </select>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the Blue Shield credential workbook used for secure portal sign-in."
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
          description="Upload the input workbook grouped by Member ID for automated Blue Shield validation."
          fileName={inputFileName}
          icon={FileSpreadsheet}
          inputId="blueShieldInputExcel"
          onFileSelect={onInputFileChange}
          sizeHint="25 MB"
          title="Upload Claim File"
        />
      </div>

      <label className="flex items-center gap-3 rounded-[1.2rem] border border-sky-100 bg-white/80 px-4 py-3 text-sm text-slate-700 shadow-sm">
        <input
          type="checkbox"
          checked={resetCheckpoint}
          onChange={(event) => onResetCheckpointChange(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-blue-600"
        />
        Reset saved checkpoint for this workbook
      </label>

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
