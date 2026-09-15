import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound, LoaderCircle, Play, Square } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

type Props = {
  inputFile: File | null;
  credentialFile: File | null;
  isRunning: boolean;
  canStart: boolean;
  onInputFileChange: (file: File | null) => void;
  onCredentialFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
};

export function TriZettoInputForm(props: Props) {
  return (
    <form onSubmit={props.onSubmit} className="space-y-5">
      <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-4 text-sm text-blue-900">
        MedRevenu input uses Primary Insurance Name, Primary Insurance ID#, Patient Name, DOB, and DOS.
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <PortalUploadCard mode="file" accept=".xlsx,.xls" acceptedFormats=".xlsx, .xls" description="Upload the TriZetto login workbook containing Username, Password, and Link (login URL)." fileName={props.credentialFile?.name} icon={KeyRound} inputId="trizettoEligibilityCredentials" onFileSelect={props.onCredentialFileChange} sizeHint="25 MB" title="Upload TriZetto Login File" />
        <PortalUploadCard mode="file" accept=".xlsx,.xls" acceptedFormats=".xlsx, .xls" description="Upload the MedRevenu eligibility workbook containing Primary Insurance Name, Primary Insurance ID#, Patient Name, DOB, and DOS." fileName={props.inputFile?.name} icon={FileSpreadsheet} inputId="trizettoEligibilityInput" onFileSelect={props.onInputFileChange} sizeHint="25 MB" title="Upload Eligibility File" />
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={!props.canStart} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
          {props.isRunning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start TriZetto verification
        </button>
        {props.isRunning && <button type="button" onClick={props.onCancel} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700"><Square className="h-4 w-4" />Cancel</button>}
      </div>
    </form>
  );
}

