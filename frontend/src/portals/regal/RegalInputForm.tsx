import type { FormEvent } from "react";

export function RegalInputForm({
  canSubmit,
  isProcessing,
  onLoginFileChange,
  onSubmit,
}: {
  canSubmit: boolean;
  isProcessing: boolean;
  onLoginFileChange: (file: File | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="mt-6 space-y-5" onSubmit={onSubmit}>
      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="regalLoginExcel">
          Regal login Excel
        </label>
        <input
          id="regalLoginExcel"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => onLoginFileChange(event.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-300 p-2 text-sm"
        />
        <p className="mt-2 text-sm text-slate-600">
          Optional locally when env_path_regal points to an env file with Regal login values.
        </p>
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {isProcessing ? "Processing..." : "Start Regal login"}
      </button>
    </form>
  );
}
