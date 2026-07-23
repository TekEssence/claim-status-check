import type { FormEvent } from "react";
import {
  FileSpreadsheet,
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
      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls"
          acceptedFormats=".xlsx, .xls"
          description="Upload the Waystar credential workbook with the login details required for the selected payer flow."
          fileName={props.credentialFile?.name}
          icon={KeyRound}
          inputId="waystarCredentialWorkbook"
          onFileSelect={props.onCredentialFileChange}
          sizeHint="10 MB"
          title="Upload Credential File"
        />
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls"
          acceptedFormats=".xlsx, .xls"
          description="Upload the eligibility workbook. Rows are routed automatically using Primary Insurance Name, Payer, or Insurance Name."
          fileName={props.inputFile?.name}
          icon={FileSpreadsheet}
          inputId="waystarEligibilityWorkbook"
          onFileSelect={props.onInputFileChange}
          sizeHint="25 MB"
          title="Upload Eligibility File"
        />
      </div>

      <button
        type="submit"
        disabled={!props.canStart}
        className="inline-flex w-full items-center justify-center gap-2 rounded-[1.2rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(37,99,235,0.24)] transition hover:shadow-[0_22px_40px_rgba(37,99,235,0.32)] disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
      >
        {props.isRunning
          ? <LoaderCircle className="h-4 w-4 animate-spin" />
          : <Play className="h-4 w-4" strokeWidth={2.2} />}
        {props.isRunning ? "Processing..." : "Start verification"}
      </button>

      {props.isRunning && (
        <button
          type="button"
          onClick={props.onCancel}
          className="inline-flex w-full items-center justify-center rounded-[1rem] border border-red-200 bg-white px-4 py-3 text-sm font-semibold text-red-700 shadow-sm transition hover:bg-red-50"
        >
          Cancel Processing
        </button>
      )}

      <p className="text-center text-sm text-slate-500">
        Waystar eligibility processing is connected. Upload both files, then start the automated verification run.
      </p>
    </form>
  );
}
