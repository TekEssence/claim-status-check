import type { FormEvent } from "react";
import {
  FileSpreadsheet,
  Info,
  LoaderCircle,
  Play,
} from "lucide-react";

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
    <form onSubmit={props.onSubmit} className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold">Run configuration</h2>
      <div className="mt-4 flex gap-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        Rows are routed automatically using Primary Insurance Name, Payer, or Insurance Name.
      </div>
      <FileField
        label="Eligibility input workbook"
        file={props.inputFile}
        onChange={props.onInputFileChange}
      />
      <FileField
        label="Portal credential workbook"
        file={props.credentialFile}
        onChange={props.onCredentialFileChange}
      />
      <div className="mt-5 flex gap-3">
        <button
          disabled={!props.canStart}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
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
            className="rounded-md border border-red-300 px-4 py-2.5 text-sm font-medium text-red-700"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function FileField(props: {
  label: string;
  file: File | null;
  onChange: (file: File | null) => void;
}) {
  return (
    <label className="mt-5 block">
      <span className="text-sm font-medium text-slate-700">{props.label}</span>
      <span className="mt-2 flex min-h-20 items-center gap-3 rounded-md border border-dashed border-slate-300 bg-slate-50 px-4">
        <FileSpreadsheet className="h-5 w-5 text-slate-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-slate-600">
          {props.file?.name ?? "Choose an .xlsx file"}
        </span>
        <input
          type="file"
          accept=".xlsx,.xls"
          className="text-xs"
          onChange={(event) => props.onChange(event.target.files?.[0] ?? null)}
        />
      </span>
    </label>
  );
}
