"use client";

import { FormEvent, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";

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
      const xlsxWb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
      const sheetName = xlsxWb.SheetNames[0];
      const claimRows = XLSX.utils.sheet_to_json(xlsxWb.Sheets[sheetName]);

      if (claimRows.length === 0) {
        throw new Error("Claim Excel file is empty.");
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

        const response = await fetch("/api/process-claims", {
          method: "POST",
          body: formData,
          cache: "no-store",
        });

        if (!response.body) throw new Error("No response body.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentCompleted = startIndex;
        let chunkHasError = false;

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
                  currentCompleted = eventData.completed;
                  setProgress({ completed: eventData.completed, total: eventData.total });
                } else if (eventData.type === "row_update") {
                  // --- ExcelJS: style-preserving cell update ---
                  const headerRow = worksheet.getRow(1);
                  let detailsCol = 0, statusCol = 0, errorCol = 0;

                  // Find existing bot columns by header name (ExcelJS is 1-indexed)
                  headerRow.eachCell((cell, colNum) => {
                    if (cell.value === "BotClaimDetails") detailsCol = colNum;
                    if (cell.value === "BotClaimStatusCheck") statusCol = colNum;
                    if (cell.value === "BotClaimStatusCheckError") errorCol = colNum;
                  });

                  // Append missing bot headers strictly at the END, cloning style from last existing header
                  const lastCol = Math.max(worksheet.columnCount, detailsCol, statusCol, errorCol);
                  let nextCol = lastCol + 1;

                  // Deep-clone a cell's style so it isn't shared by reference
                  const cloneStyle = (style: ExcelJS.Style): ExcelJS.Style =>
                    JSON.parse(JSON.stringify(style));

                  // Get the style reference cell from the last existing header column
                  const lastHeaderCell = headerRow.getCell(lastCol);
                  const headerStyle = cloneStyle(lastHeaderCell.style);

                  const addHeader = (col: number, label: string) => {
                    const cell = headerRow.getCell(col);
                    cell.value = label;
                    cell.style = cloneStyle(headerStyle);
                  };

                  if (detailsCol === 0) { detailsCol = nextCol++; addHeader(detailsCol, "BotClaimDetails"); }
                  if (statusCol === 0)  { statusCol  = nextCol++; addHeader(statusCol,  "BotClaimStatusCheck"); }
                  if (errorCol === 0)   { errorCol   = nextCol++; addHeader(errorCol,   "BotClaimStatusCheckError"); }
                  headerRow.commit();

                  // Update data cells (row index + 2: +1 for header, +1 for 1-based)
                  const dataRow = worksheet.getRow(eventData.index + 2);

                  // Get the style reference from the last existing data cell in this row
                  const lastDataCell = dataRow.getCell(lastCol);
                  const dataStyle = cloneStyle(lastDataCell.style);

                  const setDataCell = (col: number, value: string) => {
                    const cell = dataRow.getCell(col);
                    cell.value = value;
                    cell.style = cloneStyle(dataStyle);
                  };

                  if (eventData.update.BotClaimDetails !== undefined)
                    setDataCell(detailsCol, eventData.update.BotClaimDetails);
                  if (eventData.update.BotClaimStatusCheck !== undefined)
                    setDataCell(statusCol, eventData.update.BotClaimStatusCheck);
                  if (eventData.update.BotClaimStatusCheckError !== undefined)
                    setDataCell(errorCol, eventData.update.BotClaimStatusCheckError);
                  dataRow.commit();

                  // Write back with full style preservation
                  const updatedBuffer = await excelWb.xlsx.writeBuffer();
                  const writable = await claimFileHandle.createWritable();
                  await writable.write(updatedBuffer);
                  await writable.close();
                } else if (eventData.type === "error_screenshot") {
                  setErrorScreenshots((prev) => [...prev, { index: eventData.index, image: eventData.image }]);
                } else if (eventData.type === "debug_html") {
                  // Automatically trigger a file download for the debug HTML
                  const blob = new Blob([eventData.html], { type: "text/html" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `debug_dom_row_${eventData.index + 1}.html`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                } else if (eventData.type === "done") {
                  // Handled below loop
                } else if (eventData.type === "error") {
                  setStatus(`Error: ${eventData.message}`);
                  chunkHasError = true;
                }
              } catch (err) {
                console.error("Failed to parse event data", err);
              }
            }
          }
        }

        // Stream closed. Check if we need to auto-resume
        if (chunkHasError) {
          setIsProcessing(false);
        } else if (currentCompleted < totalRows) {
          setStatus(`Auto-resuming from row ${currentCompleted + 1}...`);
          await processChunk(currentCompleted);
        } else {
          setStatus("Processing completed!");
          setIsProcessing(false);
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
