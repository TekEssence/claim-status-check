import type { FormEvent } from "react";
import type { FileSystemFileHandle } from "../../types/file-system-access";

export function IehpInputForm({
  canSubmit,
  claimFileName,
  isProcessing,
  isResumePending,
  onLoginFileChange,
  onSelectClaimFile,
  onSubmit,
}: {
  canSubmit: boolean;
  claimFileName: string;
  isProcessing: boolean;
  isResumePending?: boolean;
  onLoginFileChange: (file: File | null) => void;
  onSelectClaimFile: () => Promise<FileSystemFileHandle | null> | void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="mt-6 space-y-5" onSubmit={onSubmit}>
      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="loginExcel">
          1. Provide Login excel
        </label>
        <input
          id="loginExcel"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => onLoginFileChange(event.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-300 p-2 text-sm"
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium">
          2. Select Claim details sheet (Requires Chrome/Edge)
        </label>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => void onSelectClaimFile()}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Choose File
          </button>
          <span className="text-sm text-slate-600">
            {claimFileName || "No file chosen"}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">We will update this exact file as processing continues.</p>
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {isProcessing ? "Processing..." : isResumePending ? "Allow And Continue" : "Start processing"}
      </button>
    </form>
  );
}
