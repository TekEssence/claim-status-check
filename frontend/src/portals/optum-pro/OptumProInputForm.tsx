import type { FormEvent } from "react";

export function OptumProInputForm({
  canSubmit,
  isProcessing,
  onInputFileChange,
  onLoginFileChange,
  onSubmit,
}: {
  canSubmit: boolean;
  isProcessing: boolean;
  onInputFileChange: (file: File | null) => void;
  onLoginFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="mt-6 space-y-5" onSubmit={onSubmit}>
      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="optumProLoginExcel">
          Optum Pro login Excel
        </label>
        <input
          id="optumProLoginExcel"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => onLoginFileChange(event.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-300 p-2 text-sm"
        />
        <p className="mt-2 text-sm text-slate-600">
          Required columns: One Healthcare ID or Email Address, Password. Optional: Login URL.
        </p>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="optumProInputExcel">
          Optum Pro claim Excel
        </label>
        <input
          id="optumProInputExcel"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => onInputFileChange(event.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-300 p-2 text-sm"
        />
        <p className="mt-2 text-sm text-slate-600">
          Required columns: Group Name, Patient, DOS, CPT, Member Id. Extra columns are preserved in the upload.
        </p>
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {isProcessing ? "Processing..." : "Start Optum Pro processing"}
      </button>
    </form>
  );
}
