"use client";

import { FormEvent, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { applyClaimRowUpdateToWorksheet, postProcessWorksheet } from "../portals/iehp/workbook";
import { startProcessClaimsJob, subscribeToProcessClaimEvents } from "../api/process-claims-api";
import type { FileSystemFileHandle, WindowWithFilePicker } from "../types/file-system-access";
import type { ClaimRow, ErrorScreenshot, JobProgressValue, ProcessClaimEvent } from "../types/job";
import { IehpInputForm } from "../portals/iehp/IehpInputForm";
import { IehpResultView } from "../portals/iehp/IehpResultView";
import { iehpFrontendPortalConfig } from "../portals/iehp/portal-config";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function downloadTextFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadPdfFile(filename: string, base64: string): void {
  const binaryString = window.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function selectExcelFileHandle(): Promise<FileSystemFileHandle | null> {
  const picker = (window as WindowWithFilePicker).showOpenFilePicker;
  if (!picker) {
    throw new Error("Your browser does not support direct file updates. Use Chrome or Edge.");
  }

  const [fileHandle] = await picker({
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

  return fileHandle ?? null;
}

export function ScraperPage() {
  const [loginFile, setLoginFile] = useState<File | null>(null);
  const [claimFileHandle, setClaimFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [claimFileName, setClaimFileName] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorScreenshots, setErrorScreenshots] = useState<ErrorScreenshot[]>([]);
  const [progress, setProgress] = useState<JobProgressValue | null>(null);

  const canSubmit = useMemo(
    () => Boolean(loginFile && claimFileHandle && !isProcessing),
    [loginFile, claimFileHandle, isProcessing],
  );

  async function selectClaimFile() {
    try {
      const fileHandle = await selectExcelFileHandle();
      if (!fileHandle) return null;

      setClaimFileHandle(fileHandle);
      const file = await fileHandle.getFile();
      setClaimFileName(file.name);
      return fileHandle;
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error("Failed to select file:", error);
        setStatus(`Failed to select file: ${getErrorMessage(error)}`);
      }
      return null;
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
      if ((await claimFileHandle.queryPermission({ mode: "readwrite" })) !== "granted") {
        if ((await claimFileHandle.requestPermission({ mode: "readwrite" })) !== "granted") {
          throw new Error("Write permission denied. Cannot update Excel file.");
        }
      }

      const file = await claimFileHandle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const xlsxWb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
      const sheetName = xlsxWb.SheetNames[0];
      const rawClaimRows = XLSX.utils.sheet_to_json(xlsxWb.Sheets[sheetName]) as Record<string, unknown>[];
      const claimRows: ClaimRow[] = rawClaimRows.map((row, idx) => ({ ...row, __original_index: idx }));

      if (claimRows.length === 0) {
        throw new Error("Claim Excel file contains no rows to process.");
      }

      const excelWb = new ExcelJS.Workbook();
      await excelWb.xlsx.load(arrayBuffer);
      const worksheet = excelWb.getWorksheet(1);
      if (!worksheet) {
        throw new Error("Claim Excel file does not contain a worksheet.");
      }

      const totalRows = claimRows.length;
      setStatus(`Starting process for ${totalRows} rows...`);

      const writeWorkbookToClaimFile = async () => {
        const permission = await claimFileHandle.queryPermission({ mode: "readwrite" });
        if (permission !== "granted") {
          const requestedPermission = await claimFileHandle.requestPermission({ mode: "readwrite" });
          if (requestedPermission !== "granted") {
            throw new Error("Browser write permission was denied. Please allow file access and run again.");
          }
        }

        const updatedBuffer = await excelWb.xlsx.writeBuffer();
        const writable = await claimFileHandle.createWritable();
        await writable.write(updatedBuffer);
        await writable.close();
      };

      const processChunk = async (startIndex: number): Promise<void> => {
        const formData = new FormData();
        formData.append("loginExcel", loginFile);
        formData.append("claimRows", JSON.stringify(claimRows));
        formData.append("startIndex", startIndex.toString());

        let currentCompleted = startIndex;
        let chunkHasError = false;
        let writeQueue = Promise.resolve();
        let writeFailure: Error | null = null;
        let writeFailureAlertShown = false;
        const streamAbortController = new AbortController();

        const handleWriteFailure = (error: unknown): never => {
          const message = getErrorMessage(error);
          const userMessage = `Excel update failed. The workbook may be open, locked, moved, or browser file permission may have been lost. Please close Excel, verify file access, and run again. Some recent updates may not have been saved. Details: ${message}`;
          const failure = new Error(userMessage);
          writeFailure = failure;
          chunkHasError = true;
          setStatus(`Error: ${userMessage}`);
          streamAbortController.abort();
          if (!writeFailureAlertShown) {
            writeFailureAlertShown = true;
            window.alert(userMessage);
          }
          throw failure;
        };

        const handleJobEvent = async (eventData: ProcessClaimEvent) => {
          if (eventData.type === "log" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
          } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
            currentCompleted = eventData.completed;
            setProgress({ completed: eventData.completed, total: eventData.total });
          } else if (eventData.type === "row_update") {
            applyClaimRowUpdateToWorksheet(worksheet, {
              index: eventData.index ?? 0,
              update: eventData.update ?? {},
            });

            writeQueue = writeQueue.then(async () => {
              try {
                await writeWorkbookToClaimFile();
              } catch (writeErr) {
                console.error("Failed to write to file:", writeErr);
                handleWriteFailure(writeErr);
              }
            });
          } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
            setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
          } else if (eventData.type === "debug_html" && typeof eventData.index === "number" && eventData.html) {
            downloadTextFile(`debug_dom_row_${eventData.index + 1}.html`, eventData.html, "text/html");
          } else if (eventData.type === "pdf_download" && eventData.filename && eventData.base64) {
            try {
              downloadPdfFile(eventData.filename, eventData.base64);
            } catch (error) {
              console.error("Failed to process pdf_download event", error);
            }
          } else if (eventData.type === "error" && eventData.message) {
            setStatus(`Error: ${eventData.message}`);
            chunkHasError = true;
          }
        };

        try {
          const jobId = await startProcessClaimsJob(formData);
          await subscribeToProcessClaimEvents({
            jobId,
            signal: streamAbortController.signal,
            onEvent: handleJobEvent,
            onStreamError(error) {
              console.error("Stream error:", error);
              chunkHasError = true;
            },
          });

          await writeQueue;
        } catch (error) {
          if (writeFailure) {
            console.error("Processing stopped because Excel write failed", writeFailure);
          } else {
            console.error("fetchEventSource failed", error);
            chunkHasError = true;
          }
        }

        if (chunkHasError) {
          setIsProcessing(false);
        } else if (currentCompleted < totalRows) {
          setStatus(`Auto-resuming from row ${currentCompleted + 1}...`);
          await processChunk(currentCompleted);
        } else {
          try {
            setStatus("Running post-processing (generating summary columns & duplicating rows)...");
            postProcessWorksheet(worksheet);
            await writeWorkbookToClaimFile();
            setStatus("Processing completed!");
          } catch (postError) {
            console.error("Post-processing failed", postError);
            setStatus(`Processing succeeded but post-processing failed: ${getErrorMessage(postError)}`);
          } finally {
            setIsProcessing(false);
          }
        }
      };

      await processChunk(0);
    } catch (error) {
      setStatus(`Failed to process claims: ${getErrorMessage(error)}`);
      setIsProcessing(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-900">
      <div className="mx-auto w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold">{iehpFrontendPortalConfig.name}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {iehpFrontendPortalConfig.description}
        </p>

        <IehpInputForm
          canSubmit={canSubmit}
          claimFileName={claimFileName}
          isProcessing={isProcessing}
          onLoginFileChange={setLoginFile}
          onSelectClaimFile={selectClaimFile}
          onSubmit={onSubmit}
        />

        <IehpResultView
          errorScreenshots={errorScreenshots}
          logs={logs}
          progress={progress}
          status={status}
        />
      </div>
    </main>
  );
}
