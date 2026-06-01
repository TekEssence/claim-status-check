"use client";

import { FormEvent, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { applyClaimRowUpdateToWorksheet, postProcessWorksheet } from "@/lib/claim-workbook";
import { fetchEventSource } from "@microsoft/fetch-event-source";

export default function Home() {
  const [loginFile, setLoginFile] = useState<File | null>(null);
  
  // File System Access Handle for Claims Excel
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [claimFileHandle, setClaimFileHandle] = useState<any>(null);
  const [claimFileName, setClaimFileName] = useState<string>("");
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorScreenshots, setErrorScreenshots] = useState<{ index: number; image: string }[]>([]);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);

  const canSubmit = useMemo(
    () => Boolean(loginFile && claimFileHandle && !isProcessing),
    [loginFile, claimFileHandle, isProcessing],
  );

  async function selectClaimFile() {
    try {
      // @ts-expect-error window.showOpenFilePicker exists in modern browsers
      const [fileHandle] = await window.showOpenFilePicker({
        types: [
          {
            description: "Excel Files",
            accept: {
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
              "application/vnd.ms-excel": [".xls"],
            },
          },
        ],
        excludeAcceptAllOption: true,
        multiple: false,
      });

      setClaimFileHandle(fileHandle);
      const file = await fileHandle.getFile();
      setClaimFileName(file.name);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("Failed to select file:", err);
      }
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!loginFile || !claimFileHandle) {
      setStatus("Please provide both required files.");
      return;
    }

    setIsProcessing(true);
    setStatus("Reading claim file...");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);

    try {
      // Request write permission if not already granted
      if ((await claimFileHandle.queryPermission({ mode: "readwrite" })) !== "granted") {
        if ((await claimFileHandle.requestPermission({ mode: "readwrite" })) !== "granted") {
          throw new Error("Write permission denied. Cannot update Excel file.");
        }
      }

      // Read file with SheetJS (fast, for extracting claim data to send to backend)
      const file = await claimFileHandle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const xlsxWb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
      const sheetName = xlsxWb.SheetNames[0];
      const rawClaimRows = XLSX.utils.sheet_to_json(xlsxWb.Sheets[sheetName]) as Record<string, any>[];
      const claimRows = rawClaimRows
        .map((row, idx) => ({ ...row, __original_index: idx } as Record<string, any>))
        .filter((row) => {
          const memberId = row["Member Policy ID"] ?? row["member policy id"] ?? row["Member ID"] ?? row["member id"];
          const dos = row["Date Of Service"] ?? row["DOS"] ?? row["date of service"] ?? row["dos"];
          return memberId !== undefined && memberId !== null && String(memberId).trim() !== "" &&
                 dos !== undefined && dos !== null && String(dos).trim() !== "";
        });

      if (claimRows.length === 0) {
        throw new Error("Claim Excel file contains no valid rows with Member ID and DOS.");
      }

      // Load with ExcelJS for style-preserving writes
      const excelWb = new ExcelJS.Workbook();
      await excelWb.xlsx.load(arrayBuffer);
      const worksheet = excelWb.getWorksheet(1)!;

      const totalRows = claimRows.length;
      setStatus(`Starting process for ${totalRows} rows...`);

      const processChunk = async (startIndex: number) => {
        const formData = new FormData();
        formData.append("loginExcel", loginFile);
        formData.append("claimRows", JSON.stringify(claimRows));
        formData.append("startIndex", startIndex.toString());

        let currentCompleted = startIndex;
        let chunkHasError = false;
        let writeQueue = Promise.resolve();

        try {
          await fetchEventSource("/api/process-claims", {
            method: "POST",
            body: formData,
            async onmessage(ev) {
              try {
                if (ev.data === "" || ev.data.startsWith(":")) return;
                
                const eventData = JSON.parse(ev.data);
                
                if (eventData.type === "log") {
                  setLogs((prev) => [...prev, eventData.message]);
                } else if (eventData.type === "progress") {
                  currentCompleted = eventData.completed;
                  setProgress({ completed: eventData.completed, total: eventData.total });
                } else if (eventData.type === "row_update") {
                  applyClaimRowUpdateToWorksheet(worksheet, eventData);

                  // Queue the write to avoid concurrent access to the same file
                  writeQueue = writeQueue.then(async () => {
                    try {
                      const updatedBuffer = await excelWb.xlsx.writeBuffer();
                      const writable = await claimFileHandle.createWritable();
                      await writable.write(updatedBuffer);
                      await writable.close();
                    } catch (writeErr) {
                      console.error("Failed to write to file:", writeErr);
                    }
                  });
                } else if (eventData.type === "error_screenshot") {
                  setErrorScreenshots((prev) => [...prev, { index: eventData.index, image: eventData.image }]);
                } else if (eventData.type === "debug_html") {
                  const blob = new Blob([eventData.html], { type: "text/html" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `debug_dom_row_${eventData.index + 1}.html`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                } else if (eventData.type === "pdf_download") {
                  try {
                    const binaryString = window.atob(eventData.base64);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                      bytes[i] = binaryString.charCodeAt(i);
                    }
                    const blob = new Blob([bytes], { type: "application/pdf" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = eventData.filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                  } catch (err) {
                    console.error("Failed to process pdf_download event", err);
                  }
                } else if (eventData.type === "done") {
                  // Handled below loop
                } else if (eventData.type === "error") {
                  setStatus(`Error: ${eventData.message}`);
                  chunkHasError = true;
                }
              } catch (err) {
                console.error("Failed to parse event data", err);
              }
            },
            onerror(err) {
              console.error("Stream error:", err);
              chunkHasError = true;
              throw err; // Throw to prevent infinite reconnect attempts
            }
          });

          // Wait for any pending writes to finish
          await writeQueue;
        } catch (err) {
          console.error("fetchEventSource failed", err);
          chunkHasError = true;
        }

        // Stream closed. Check if we need to auto-resume
        if (chunkHasError) {
          setIsProcessing(false);
        } else if (currentCompleted < totalRows) {
          setStatus(`Auto-resuming from row ${currentCompleted + 1}...`);
          await processChunk(currentCompleted);
        } else {
          try {
            setStatus("Running post-processing (generating summary columns & duplicating rows)...");
            postProcessWorksheet(worksheet);

            // Write back with full style preservation
            const updatedBuffer = await excelWb.xlsx.writeBuffer();
            const writable = await claimFileHandle.createWritable();
            await writable.write(updatedBuffer);
            await writable.close();

            setStatus("Processing completed!");
          } catch (postError) {
            console.error("Post-processing failed", postError);
            setStatus(`Processing succeeded but post-processing failed: ${postError instanceof Error ? postError.message : String(postError)}`);
          } finally {
            setIsProcessing(false);
          }
        }
      };

      await processChunk(0);
    } catch (error) {
      setStatus(
        `Failed to process claims: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
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

        {errorScreenshots.length > 0 && (
          <div className="mt-4 flex flex-col gap-4">
            {errorScreenshots.map((err, i) => (
              <div key={i} className="rounded-md border border-red-200 bg-red-50 p-3">
                <h2 className="mb-2 text-sm font-semibold text-red-700">
                  {err.index === -1 ? "Login Error Screenshot" : `Error Screenshot for Row ${err.index + 1}`}
                </h2>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img 
                  src={`data:image/jpeg;base64,${err.image}`} 
                  alt="Browser state on error" 
                  className="max-w-full rounded border border-red-200 shadow-sm"
                />
              </div>
            ))}
          </div>
        )}

        {logs.length > 0 && (
          <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
            <h2 className="mb-2 text-sm font-semibold">Live Processing Logs</h2>
            <ul className="max-h-64 list-disc space-y-1 overflow-auto pl-5 text-xs text-slate-700">
              {logs.map((line, idx) => (
                <li key={idx}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
