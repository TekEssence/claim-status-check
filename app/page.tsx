"use client";

import { FormEvent, useMemo, useState } from "react";
import * as XLSX from "xlsx";

export default function Home() {
  const [loginFile, setLoginFile] = useState<File | null>(null);
  
  // File System Access Handle for Claims Excel
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [claimFileHandle, setClaimFileHandle] = useState<any>(null);
  const [claimFileName, setClaimFileName] = useState<string>("");
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorScreenshot, setErrorScreenshot] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);

  const canSubmit = useMemo(
    () => Boolean(loginFile && claimFileHandle && !isProcessing),
    [loginFile, claimFileHandle, isProcessing],
  );

  async function selectClaimFile() {
    try {
      // @ts-expect-error - File System Access API is not fully typed in all TS setups
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: "Excel Files",
            accept: {
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
              "application/vnd.ms-excel": [".xls"],
              "text/csv": [".csv"],
            },
          },
        ],
      });
      setClaimFileHandle(handle);
      setClaimFileName(handle.name);
    } catch (e) {
      console.error(e);
      // User likely cancelled the picker
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loginFile || !claimFileHandle) {
      setStatus("Please provide both required files.");
      return;
    }

    setIsProcessing(true);
    setStatus("Reading claim file...");
    setLogs([]);
    setErrorScreenshot(null);
    setProgress(null);

    try {
      // Request write permission if not already granted
      if ((await claimFileHandle.queryPermission({ mode: "readwrite" })) !== "granted") {
        if ((await claimFileHandle.requestPermission({ mode: "readwrite" })) !== "granted") {
          throw new Error("Write permission denied. Cannot update Excel file.");
        }
      }

      // Read the file locally
      const file = await claimFileHandle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const claimRows = XLSX.utils.sheet_to_json(sheet);

      if (claimRows.length === 0) {
        throw new Error("Claim Excel file is empty.");
      }

      setStatus(`Starting process for ${claimRows.length} rows...`);

      const formData = new FormData();
      formData.append("loginExcel", loginFile);
      formData.append("claimRows", JSON.stringify(claimRows));

      const response = await fetch("/api/process-claims", {
        method: "POST",
        body: formData,
      });

      if (!response.body) throw new Error("No response body.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.substring(6);
            try {
              const eventData = JSON.parse(dataStr);
              
              if (eventData.type === "log") {
                setLogs((prev) => [...prev, eventData.message]);
              } else if (eventData.type === "progress") {
                setProgress({ completed: eventData.completed, total: eventData.total });
              } else if (eventData.type === "row_update") {
                // Update the row in our local array
                claimRows[eventData.index] = { 
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ...(claimRows[eventData.index] as any), 
                  ...eventData.update 
                };
                
                // Save it back to the Excel file incrementally
                const updatedSheet = XLSX.utils.json_to_sheet(claimRows);
                workbook.Sheets[sheetName] = updatedSheet;
                const updatedArrayBuffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
                
                // Write to the original file in place
                const writable = await claimFileHandle.createWritable();
                await writable.write(updatedArrayBuffer);
                await writable.close();
              } else if (eventData.type === "error_screenshot") {
                setErrorScreenshot(eventData.image);
              } else if (eventData.type === "done") {
                setStatus("Processing completed!");
              } else if (eventData.type === "error") {
                setStatus(`Error: ${eventData.message}`);
              }
            } catch (err) {
              console.error("Failed to parse event data", err);
            }
          }
        }
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
          Upload the login Excel and select your claim details Excel. The claim file will be updated in place as processing occurs.
        </p>

        <form className="mt-6 space-y-5" onSubmit={onSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium" htmlFor="loginExcel">
              1. Provide Login excel
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
            <label className="mb-2 block text-sm font-medium">
              2. Select Claim details sheet (Requires Chrome/Edge)
            </label>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={selectClaimFile}
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
            {isProcessing ? "Processing..." : "Start processing"}
          </button>
        </form>

        {progress && (
          <div className="mt-6">
            <div className="mb-1 flex justify-between text-sm font-medium text-slate-700">
              <span>Progress</span>
              <span>{progress.completed} of {progress.total} rows</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div 
                className="h-full bg-blue-600 transition-all duration-300"
                style={{ width: `${(progress.completed / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {status && (
          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm font-medium">
            {status}
          </div>
        )}

        {errorScreenshot && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3">
            <h2 className="mb-2 text-sm font-semibold text-red-700">Error Screenshot</h2>
            <img 
              src={`data:image/jpeg;base64,${errorScreenshot}`} 
              alt="Browser state on error" 
              className="max-w-full rounded border border-red-200 shadow-sm"
            />
          </div>
        )}

        {logs.length > 0 && (
          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
            <h2 className="mb-2 text-sm font-semibold">Live Processing Logs</h2>
            <ul className="max-h-64 list-disc space-y-1 overflow-auto pl-5 text-xs text-slate-700">
              {logs.map((line, idx) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={idx}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
