"use client";

import { FormEvent, useMemo, useState } from "react";

type ProcessResponse = {
  success: boolean;
  message: string;
  processedRows?: number;
  outputFileName?: string;
  outputFileBase64?: string;
  logs?: string[];
};

export default function Home() {
  const [loginFile, setLoginFile] = useState<File | null>(null);
  const [claimFile, setClaimFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);

  const canSubmit = useMemo(
    () => Boolean(loginFile && claimFile && !isProcessing),
    [loginFile, claimFile, isProcessing],
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loginFile || !claimFile) {
      setStatus("Please upload both required files.");
      return;
    }

    setIsProcessing(true);
    setStatus("Processing started...");
    setLogs([]);

    try {
      const formData = new FormData();
      formData.append("loginExcel", loginFile);
      formData.append("claimExcel", claimFile);

      const response = await fetch("/api/process-claims", {
        method: "POST",
        body: formData,
      });

      const result = (await response.json()) as ProcessResponse;
      setLogs(result.logs ?? []);
      setStatus(result.message);

      if (result.success && result.outputFileBase64 && result.outputFileName) {
        const bytes = Uint8Array.from(atob(result.outputFileBase64), (char) =>
          char.charCodeAt(0),
        );
        const blob = new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.outputFileName;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      setStatus(
        `Failed to process claims: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-900">
      <div className="mx-auto w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold">IEHP Claim Status Check</h1>
        <p className="mt-2 text-sm text-slate-600">
          Upload the login Excel and claim details Excel, then start processing.
        </p>

        <form className="mt-6 space-y-5" onSubmit={onSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium" htmlFor="loginExcel">
              Provide Login excel
            </label>
            <input
              id="loginExcel"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) =>
                setLoginFile(event.target.files?.[0] ?? null)
              }
              className="block w-full rounded-md border border-slate-300 p-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium" htmlFor="claimExcel">
              Provide claim details sheet
            </label>
            <input
              id="claimExcel"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) =>
                setClaimFile(event.target.files?.[0] ?? null)
              }
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

        {status && (
          <div className="mt-6 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
            {status}
          </div>
        )}

        {logs.length > 0 && (
          <div className="mt-4 rounded-md border border-slate-200 bg-white p-3">
            <h2 className="mb-2 text-sm font-semibold">Processing Logs</h2>
            <ul className="max-h-64 list-disc space-y-1 overflow-auto pl-5 text-xs text-slate-700">
              {logs.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
