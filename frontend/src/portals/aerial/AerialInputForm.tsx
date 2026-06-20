import type { FormEvent } from "react";

export function AerialInputForm({
  canSubmit,
  isProcessing,
  onInputFileChange,
  onSubmit,
}: {
  canSubmit: boolean;
  isProcessing: boolean;
  onInputFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="mt-6 space-y-5" onSubmit={onSubmit}>
      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="aerialInputExcel">
          Provide Aerial input Excel
        </label>
        <input
          id="aerialInputExcel"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => onInputFileChange(event.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-300 p-2 text-sm"
        />
      </div>

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
