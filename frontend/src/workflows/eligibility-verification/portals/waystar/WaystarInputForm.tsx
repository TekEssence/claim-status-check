import type { FormEvent } from "react";
import {
  FileSpreadsheet,
  Info,
  KeyRound,
  LoaderCircle,
  Play,
} from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

export function WaystarInputForm(props: {
  inputFile: File | null;
  credentialFile: File | null;
  isRunning: boolean;
  canStart: boolean;
  onInputFileChange: (file: File | null) => void;
  onCredentialFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={props.onSubmit} className="space-y-5">
      <h2 className="font-semibold text-slate-900">Run configuration</h2>
      <div className="flex gap-3 rounded-[1.1rem] border border-blue-100 bg-blue-50/70 p-4 text-sm text-blue-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        Rows are routed automatically using Primary Insurance Name, Payer, or Insurance Name.
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard mode="file" accept=".xlsx,.xls" acceptedFormats=".xlsx, .xls" description="Upload the Waystar username, password, provider, and verification details." fileName={props.credentialFile?.name} icon={KeyRound} inputId="waystarCredentialExcel" onFileSelect={props.onCredentialFileChange} sizeHint="10 MB" title="Upload Login File" />
        <PortalUploadCard mode="file" accept=".xlsx,.xls" acceptedFormats=".xlsx, .xls" description="Upload the member eligibility rows to verify through Waystar." fileName={props.inputFile?.name} icon={FileSpreadsheet} inputId="waystarEligibilityExcel" onFileSelect={props.onInputFileChange} sizeHint="25 MB" title="Upload Eligibility File" />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          disabled={!props.canStart}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-[1.2rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(37,99,235,0.24)] transition hover:shadow-[0_22px_40px_rgba(37,99,235,0.32)] disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
        >
          {props.isRunning
            ? <LoaderCircle className="h-4 w-4 animate-spin" />
            : <Play className="h-4 w-4" />}
          Start verification
        </button>
        {props.isRunning && (
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-[1.2rem] border border-red-200 bg-white px-5 py-3.5 text-sm font-semibold text-red-700 transition hover:bg-red-50"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
