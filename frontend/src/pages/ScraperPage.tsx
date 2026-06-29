"use client";

import { FormEvent, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { applyClaimRowUpdateToWorksheet, postProcessWorksheet } from "../portals/iehp/workbook";
import { startScrapeJob, subscribeToScrapeJobEvents } from "../api/scrape-jobs-api";
import type { FileSystemFileHandle, WindowWithFilePicker } from "../types/file-system-access";
import type { ClaimRow, ErrorScreenshot, JobProgressValue, ScrapeJobEvent } from "../types/job";
import { IehpInputForm } from "../portals/iehp/IehpInputForm";
import { IehpResultView } from "../portals/iehp/IehpResultView";
import { iehpFrontendPortalConfig } from "../portals/iehp/portal-config";
import { AerialInputForm } from "../portals/aerial/AerialInputForm";
import { AerialResultView } from "../portals/aerial/AerialResultView";
import { aerialFrontendPortalConfig } from "../portals/aerial/portal-config";
import { BlueShieldInputForm } from "../portals/blue-shield/BlueShieldInputForm";
import { BlueShieldResultView } from "../portals/blue-shield/BlueShieldResultView";
import { blueShieldFrontendPortalConfig } from "../portals/blue-shield/portal-config";

type PortalId = "iehp" | "aerial" | "blue-shield";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function downloadTextFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  downloadBlob(filename, blob);
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function base64ToBytes(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function downloadBase64File(filename: string, base64: string, type: string): void {
  const bytes = base64ToBytes(base64);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  downloadBlob(filename, new Blob([arrayBuffer], { type }));
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
  const [selectedPortalId, setSelectedPortalId] = useState<PortalId | null>(null);
  const [iehpLoginFile, setIehpLoginFile] = useState<File | null>(null);
  const [claimFileHandle, setClaimFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [claimFileName, setClaimFileName] = useState<string>("");
  const [aerialCredentialFile, setAerialCredentialFile] = useState<File | null>(null);
  const [aerialInputFile, setAerialInputFile] = useState<File | null>(null);
  const [blueShieldCredentialFile, setBlueShieldCredentialFile] = useState<File | null>(null);
  const [blueShieldInputFile, setBlueShieldInputFile] = useState<File | null>(null);
  const [blueShieldGroup, setBlueShieldGroup] = useState("Posada");
  const [blueShieldResetCheckpoint, setBlueShieldResetCheckpoint] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorScreenshots, setErrorScreenshots] = useState<ErrorScreenshot[]>([]);
  const [progress, setProgress] = useState<JobProgressValue | null>(null);

  const selectedPortal =
    selectedPortalId === "iehp"
      ? iehpFrontendPortalConfig
      : selectedPortalId === "aerial"
        ? aerialFrontendPortalConfig
        : selectedPortalId === "blue-shield"
          ? blueShieldFrontendPortalConfig
          : null;
  const canSubmitIehp = useMemo(
    () => Boolean(iehpLoginFile && claimFileHandle && !isProcessing),
    [iehpLoginFile, claimFileHandle, isProcessing],
  );
  const canSubmitAerial = useMemo(
    () => Boolean(aerialInputFile && !isProcessing),
    [aerialInputFile, isProcessing],
  );
  const canSubmitBlueShield = useMemo(
    () => Boolean(blueShieldCredentialFile && blueShieldInputFile && !isProcessing),
    [blueShieldCredentialFile, blueShieldInputFile, isProcessing],
  );

  function resetRunState(message: string) {
    setIsProcessing(true);
    setStatus(message);
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
  }

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

  async function submitIehp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!iehpLoginFile || !claimFileHandle) {
      setStatus("Please provide both required files.");
      return;
    }

    resetRunState("Reading claim file...");

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
      setStatus(`Starting IEHP process for ${totalRows} rows...`);

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
        formData.append("portalId", "iehp");
        formData.append("loginExcel", iehpLoginFile);
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

        const handleJobEvent = async (eventData: ScrapeJobEvent) => {
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
            downloadBase64File(eventData.filename, eventData.base64, "application/pdf");
          } else if (eventData.type === "error" && eventData.message) {
            setStatus(`Error: ${eventData.message}`);
            chunkHasError = true;
          }
        };

        try {
          const jobId = await startScrapeJob(formData);
          await subscribeToScrapeJobEvents({
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
            setStatus("IEHP processing completed.");
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
      setStatus(`Failed to process IEHP claims: ${getErrorMessage(error)}`);
      setIsProcessing(false);
    }
  }

  async function submitAerial(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!aerialInputFile) {
      setStatus("Please provide the Aerial input Excel file.");
      return;
    }

    resetRunState("Starting Aerial scraper...");

    const formData = new FormData();
    formData.append("portalId", "aerial");
    if (aerialCredentialFile) {
      formData.append("credentialExcel", aerialCredentialFile);
    }
    formData.append("inputExcel", aerialInputFile);

    let hasError = false;
    let finalErrorMessage = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total });
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
        downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
        setStatus(`Downloaded ${eventData.filename}`);
      } else if (eventData.type === "warning" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
        setStatus(eventData.message);
      } else if (eventData.type === "error" && eventData.message) {
        finalErrorMessage = eventData.message;
        setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
        setStatus(`Error: ${eventData.message}`);
        hasError = true;
      }
    };

    try {
      const jobId = await startScrapeJob(formData);
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Aerial stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        hasError
          ? `Aerial processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Aerial processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Aerial claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
    }
  }

  async function submitBlueShield(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!blueShieldCredentialFile || !blueShieldInputFile) {
      setStatus("Please provide both the Blue Shield login Excel and input Excel files.");
      return;
    }

    resetRunState("Starting Blue Shield scraper...");

    const formData = new FormData();
    formData.append("portalId", "blue-shield");
    formData.append("group", blueShieldGroup);
    formData.append("credentialExcel", blueShieldCredentialFile);
    formData.append("inputExcel", blueShieldInputFile);
    formData.append("checkpointId", blueShieldInputFile.name || "blue-shield");
    formData.append("resetCheckpoint", blueShieldResetCheckpoint ? "true" : "false");

    let hasError = false;
    let finalErrorMessage = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total });
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
        downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
        setStatus(`Downloaded ${eventData.filename}`);
      } else if (eventData.type === "warning" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
        setStatus(eventData.message);
      } else if (eventData.type === "error" && eventData.message) {
        finalErrorMessage = eventData.message;
        setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
        setStatus(`Error: ${eventData.message}`);
        hasError = true;
      }
    };

    try {
      const jobId = await startScrapeJob(formData);
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Blue Shield stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        hasError
          ? `Blue Shield processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Blue Shield processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Blue Shield claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-900">
      <div className="mx-auto w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {!selectedPortal ? (
          <>
            <h1 className="text-2xl font-semibold">Select Portal</h1>
            <p className="mt-2 text-sm text-slate-600">Choose the portal scraper you want to run.</p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {([iehpFrontendPortalConfig, aerialFrontendPortalConfig, blueShieldFrontendPortalConfig] as const).map((portal) => (
                <button
                  key={portal.id}
                  type="button"
                  onClick={() => {
                    setSelectedPortalId(portal.id as PortalId);
                    setStatus("");
                    setLogs([]);
                    setErrorScreenshots([]);
                    setProgress(null);
                  }}
                  className="rounded-lg border border-slate-300 bg-white p-5 text-left shadow-sm hover:border-blue-500 hover:bg-blue-50"
                >
                  <span className="block text-lg font-semibold">{portal.name}</span>
                  <span className="mt-2 block text-sm text-slate-600">{portal.description}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{selectedPortal.name}</h1>
            <p className="mt-2 max-w-xl text-sm text-slate-600">{selectedPortal.description}</p>
          </div>

              <button
                type="button"
                disabled={isProcessing}
                onClick={() => {
                  setSelectedPortalId(null);
                  setStatus("");
                  setLogs([]);
                  setErrorScreenshots([]);
                  setProgress(null);
                }}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:text-slate-400"
              >
                Change portal
              </button>
        </div>

        {selectedPortalId === "iehp" ? (
          <>
            <IehpInputForm
              canSubmit={canSubmitIehp}
              claimFileName={claimFileName}
              isProcessing={isProcessing}
              onLoginFileChange={setIehpLoginFile}
              onSelectClaimFile={selectClaimFile}
              onSubmit={submitIehp}
            />
            <IehpResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
          </>
        ) : selectedPortalId === "aerial" ? (
          <>
            <AerialInputForm
              canSubmit={canSubmitAerial}
              isProcessing={isProcessing}
              onCredentialFileChange={setAerialCredentialFile}
              onInputFileChange={setAerialInputFile}
              onSubmit={submitAerial}
            />
            <AerialResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
          </>
        ) : (
          <>
            <BlueShieldInputForm
              canSubmit={canSubmitBlueShield}
              group={blueShieldGroup}
              isProcessing={isProcessing}
              resetCheckpoint={blueShieldResetCheckpoint}
              onCredentialFileChange={setBlueShieldCredentialFile}
              onGroupChange={setBlueShieldGroup}
              onInputFileChange={setBlueShieldInputFile}
              onResetCheckpointChange={setBlueShieldResetCheckpoint}
              onSubmit={submitBlueShield}
            />
            <BlueShieldResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
          </>
        )}
          </>
        )}
      </div>
    </main>
  );
}
