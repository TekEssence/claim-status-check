import type { FormEvent } from "react";

export function BlueShieldInputForm({
  canSubmit,
  group,
  isProcessing,
  resetCheckpoint,
  onCredentialFileChange,
  onGroupChange,
  onInputFileChange,
  onResetCheckpointChange,
  onSubmit,
}: {
  canSubmit: boolean;
  group: string;
  isProcessing: boolean;
  resetCheckpoint: boolean;
  onCredentialFileChange: (file: File | null) => void;
  onGroupChange: (group: string) => void;
  onInputFileChange: (file: File | null) => void;
  onResetCheckpointChange: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="mt-6 space-y-5" onSubmit={onSubmit}>
      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="blueShieldGroup">
          1. Select group
        </label>
        <select
          id="blueShieldGroup"
          value={group}
          onChange={(event) => onGroupChange(event.target.value)}
          className="block w-full rounded-md border border-slate-300 bg-white p-2 text-sm"
        >
          <option value="IUMG">IUMG</option>
          <option value="IPMG">IPMG</option>
          <option value="Posada">Posada</option>
        </select>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="blueShieldCredentialExcel">
          2. Provide Blue Shield login Excel
        </label>
        <input
          id="blueShieldCredentialExcel"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => onCredentialFileChange(event.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-300 p-2 text-sm"
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="blueShieldInputExcel">
          3. Provide Blue Shield input Excel
        </label>
        <input
          id="blueShieldInputExcel"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => onInputFileChange(event.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-300 p-2 text-sm"
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={resetCheckpoint}
          onChange={(event) => onResetCheckpointChange(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
        Reset saved checkpoint for this workbook
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {isProcessing ? "Processing..." : "Start processing"}
      </button>
    </form>
  );
}
