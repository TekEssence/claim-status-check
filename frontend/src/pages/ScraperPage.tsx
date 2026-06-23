"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { applyClaimRowUpdateToWorksheet, postProcessWorksheet } from "../portals/iehp/workbook";
import { getCurrentScrapeJob, startScrapeJob, subscribeToScrapeJobEvents, type CurrentScrapeJob } from "../api/scrape-jobs-api";
import { clearStoredRunContext, loadClaimFileHandle, loadIehpLoginFile, saveClaimFileHandle, saveIehpLoginFile } from "../lib/run-context-store";
import type { FileSystemFileHandle, WindowWithFilePicker } from "../types/file-system-access";
import type { ClaimRow, ErrorScreenshot, JobProgressValue, ScrapeJobEvent } from "../types/job";
import { IehpInputForm } from "../portals/iehp/IehpInputForm";
import { IehpResultView } from "../portals/iehp/IehpResultView";
import { iehpFrontendPortalConfig } from "../portals/iehp/portal-config";
import { AerialInputForm } from "../portals/aerial/AerialInputForm";
import { AerialResultView } from "../portals/aerial/AerialResultView";
import { aerialFrontendPortalConfig } from "../portals/aerial/portal-config";

type AuthUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "USER";
  mustResetPassword: boolean;
};

type ManagedUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "USER";
  isActive: boolean;
  mustResetPassword: boolean;
};

type IehpWorkbookBundle = {
  claimRows: ClaimRow[];
  totalRows: number;
  excelWb: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
};

export type PortalId = "iehp" | "aerial";

const SELECTED_PORTAL_STORAGE_KEY = "iehp-selected-portal";
const DOWNLOADED_ARTIFACTS_PREFIX = "iehp-downloaded-artifacts:";
const PORTAL_ROUTE_MAP: Record<PortalId, string> = {
  iehp: "/iehp",
  aerial: "/aerial",
};

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

function getDownloadedArtifactsKey(jobId: string): string {
  return `${DOWNLOADED_ARTIFACTS_PREFIX}${jobId}`;
}

function getDownloadedArtifactSet(jobId: string): Set<string> {
  if (typeof window === "undefined" || !jobId) return new Set<string>();
  try {
    const raw = window.localStorage.getItem(getDownloadedArtifactsKey(jobId));
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function rememberDownloadedArtifact(jobId: string, artifactKey: string): void {
  if (typeof window === "undefined" || !jobId || !artifactKey) return;
  const current = getDownloadedArtifactSet(jobId);
  current.add(artifactKey);
  try {
    window.localStorage.setItem(getDownloadedArtifactsKey(jobId), JSON.stringify(Array.from(current)));
  } catch {
    // Best effort only.
  }
}

function hasDownloadedArtifact(jobId: string, artifactKey: string): boolean {
  return getDownloadedArtifactSet(jobId).has(artifactKey);
}

function buildDownloadArtifactKey(eventData: ScrapeJobEvent): string {
  return [
    eventData.type ?? "",
    typeof eventData.index === "number" ? String(eventData.index) : "",
    eventData.filename ?? "",
    eventData.path ?? "",
  ].join("|");
}

function isMissingLocalFileError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("notfounderror") ||
    message.includes("the requested file could not be found") ||
    message.includes("could not find the file") ||
    message.includes("file or directory could not be found") ||
    message.includes("not be found")
  );
}

function isFileAccessPermissionError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("notallowederror") ||
    message.includes("securityerror") ||
    message.includes("request is not allowed by the user agent or the platform in the current context") ||
    message.includes("permission") ||
    message.includes("user activation")
  );
}

function getMissingLocalExcelMessage(fileName: string): string {
  return `The previously selected Excel file${fileName ? ` (${fileName})` : ""} was not found on this computer. Please reselect the same claim file and continue.`;
}

function getExcelReauthorizeMessage(fileName: string): string {
  return `Browser file permission is not currently granted for the selected Excel file${fileName ? ` (${fileName})` : ""}. Click Choose File once to re-authorize the same claim file and continue.`;
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

async function loadIehpWorkbookBundle(
  claimFileHandle: FileSystemFileHandle,
  options: { requestPermission?: boolean; fileNameForErrors?: string } = {},
): Promise<IehpWorkbookBundle> {
  const fileNameForErrors = options.fileNameForErrors ?? "";
  const currentPermission = await claimFileHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as const);
  if (currentPermission !== "granted") {
    if (!options.requestPermission) {
      throw new Error(getExcelReauthorizeMessage(fileNameForErrors));
    }
    if ((await claimFileHandle.requestPermission({ mode: "readwrite" }).catch(() => "denied" as const)) !== "granted") {
      throw new Error("Write permission denied. Cannot update Excel file.");
    }
  }

  let file: File;
  try {
    file = await claimFileHandle.getFile();
  } catch (error) {
    if (isMissingLocalFileError(error)) {
      throw new Error(getMissingLocalExcelMessage(fileNameForErrors));
    }
    if (isFileAccessPermissionError(error)) {
      throw new Error(getExcelReauthorizeMessage(fileNameForErrors));
    }
    throw error;
  }
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

  return {
    claimRows,
    totalRows: claimRows.length,
    excelWb,
    worksheet,
  };
}

async function writeWorkbookToClaimFile(claimFileHandle: FileSystemFileHandle, excelWb: ExcelJS.Workbook): Promise<void> {
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
}

export function ScraperPage({ forcedPortalId = null }: { forcedPortalId?: PortalId | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authStatus, setAuthStatus] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeView, setActiveView] = useState<"portal-selection" | "manage-users">("portal-selection");
  const [manageTab, setManageTab] = useState<"add" | "employees">("add");
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [manageError, setManageError] = useState("");
  const [manageStatus, setManageStatus] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [editingUserId, setEditingUserId] = useState("");
  const [editingEmail, setEditingEmail] = useState("");
  const [selectedPortalId, setSelectedPortalId] = useState<PortalId | null>(null);
  const [iehpLoginFile, setIehpLoginFile] = useState<File | null>(null);
  const [claimFileHandle, setClaimFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [claimFileName, setClaimFileName] = useState<string>("");
  const [aerialCredentialFile, setAerialCredentialFile] = useState<File | null>(null);
  const [aerialInputFile, setAerialInputFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorScreenshots, setErrorScreenshots] = useState<ErrorScreenshot[]>([]);
  const [progress, setProgress] = useState<JobProgressValue | null>(null);
  const [jobRestoreLoading, setJobRestoreLoading] = useState(true);

  const effectivePortalId = forcedPortalId ?? selectedPortalId;
  const selectedPortal =
    effectivePortalId === "iehp"
      ? iehpFrontendPortalConfig
      : effectivePortalId === "aerial"
        ? aerialFrontendPortalConfig
        : null;
  const canSubmitIehp = useMemo(
    () => Boolean(iehpLoginFile && claimFileHandle && !isProcessing),
    [iehpLoginFile, claimFileHandle, isProcessing],
  );
  const canSubmitAerial = useMemo(
    () => Boolean(aerialInputFile && !isProcessing),
    [aerialInputFile, isProcessing],
  );

  function navigateToPortalRoute(portalId: PortalId) {
    const targetRoute = PORTAL_ROUTE_MAP[portalId];
    if (pathname !== targetRoute) {
      router.replace(targetRoute);
    }
  }

  useEffect(() => {
    let mounted = true;

    fetch("/api/auth/me")
      .then(async (response) => {
        if (!mounted) return;
        if (!response.ok) {
          setAuthUser(null);
          return;
        }
        const data = await response.json();
        setAuthUser(data.user ?? null);
      })
      .catch(() => {
        if (mounted) setAuthUser(null);
      })
      .finally(() => {
        if (mounted) setAuthLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!authUser) {
      setJobRestoreLoading(false);
      return;
    }

    let cancelled = false;

    const restoreCurrentRun = async () => {
      try {
        const currentJob = await getCurrentScrapeJob();
        if (cancelled || !currentJob) return;

        setErrorScreenshots(
          (currentJob.artifacts ?? [])
            .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
            .map((artifact) => ({
              index: artifact.rowIndex ?? -1,
              image: artifact.contentBase64 ?? "",
            })),
        );
        setProgress(
          currentJob.totalRows > 0
            ? { completed: currentJob.currentCompleted, total: currentJob.totalRows }
            : null,
        );
        setStatus(`Reconnected to ${currentJob.portalId.toUpperCase()} run in progress...`);
        setIsProcessing(true);
        setSelectedPortalId(currentJob.portalId as PortalId);
        navigateToPortalRoute(currentJob.portalId as PortalId);
        setActiveView("portal-selection");

        if (currentJob.portalId === "iehp") {
          const [storedClaimHandle, storedLoginFile] = await Promise.all([loadClaimFileHandle(), loadIehpLoginFile()]);
          if (cancelled) return;

          if (storedClaimHandle) {
            setClaimFileHandle(storedClaimHandle);
            const existingPermission = await storedClaimHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as const);
            if (existingPermission !== "granted") {
              throw new Error(getExcelReauthorizeMessage(currentJob.claimFileName));
            }
            try {
              const claimFile = await storedClaimHandle.getFile();
              setClaimFileName(claimFile.name);
            } catch (error) {
              if (isMissingLocalFileError(error)) {
                throw new Error(getMissingLocalExcelMessage(currentJob.claimFileName));
              }
              if (isFileAccessPermissionError(error)) {
                throw new Error(getExcelReauthorizeMessage(currentJob.claimFileName));
              }
              throw error;
            }
          }
          if (storedLoginFile) {
            setIehpLoginFile(storedLoginFile);
          }

          if (storedClaimHandle && storedLoginFile) {
            await resumeExistingIehpRun(currentJob, storedClaimHandle, storedLoginFile);
          } else {
            if (!storedClaimHandle) {
              setStatus(`Could not restore the active run: ${getMissingLocalExcelMessage(currentJob.claimFileName)}`);
            } else {
              setStatus("A run is active, but the local IEHP login file context could not be restored automatically. Please upload the login file again if needed.");
            }
            setIsProcessing(false);
          }
        } else if (currentJob.portalId === "aerial") {
          await reconnectAerialRun(currentJob);
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(`Could not restore the active run: ${getErrorMessage(error)}`);
          setIsProcessing(false);
        }
      } finally {
        if (!cancelled) {
          setJobRestoreLoading(false);
        }
      }
    };

    void restoreCurrentRun();

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  useEffect(() => {
    if (forcedPortalId) {
      setSelectedPortalId(forcedPortalId);
      return;
    }

    if (!authUser || selectedPortalId) {
      return;
    }

    try {
      const storedPortalId = window.localStorage.getItem(SELECTED_PORTAL_STORAGE_KEY);
      if (storedPortalId === "iehp" || storedPortalId === "aerial") {
        setSelectedPortalId(storedPortalId);
        navigateToPortalRoute(storedPortalId);
      }
    } catch {
      // Ignore storage failures.
    }
  }, [authUser, selectedPortalId, forcedPortalId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (forcedPortalId) return;
    try {
      if (selectedPortalId) {
        window.localStorage.setItem(SELECTED_PORTAL_STORAGE_KEY, selectedPortalId);
      } else {
        window.localStorage.removeItem(SELECTED_PORTAL_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures.
    }
  }, [selectedPortalId, forcedPortalId]);

  function resetRunState(message: string) {
    setIsProcessing(true);
    setStatus(message);
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
  }

  function resetPortalSelection() {
    setActiveView("portal-selection");
    setSettingsOpen(false);
    if (forcedPortalId) {
      if (typeof window !== "undefined") {
        window.location.assign("/");
      }
      return;
    }
    setSelectedPortalId(null);
    try {
      window.localStorage.removeItem(SELECTED_PORTAL_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
    setStatus("");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
  }

  async function loadManagedUsers() {
    setManageError("");
    const response = await fetch("/api/admin/users");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Unable to load users.");
    }
    setManagedUsers(data.users ?? []);
  }

  async function openManageUsers() {
    setSettingsOpen(false);
    setActiveView("manage-users");
    setManageStatus("");
    try {
      await loadManagedUsers();
    } catch (error) {
      setManageError(getErrorMessage(error));
    }
  }

  async function onAuthSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthSubmitting(true);
    setAuthError("");
    setAuthStatus("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authUsername, password: authPassword }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Login failed.");
      }

      setAuthUser(data.user ?? null);
      setAuthUsername("");
      setAuthPassword("");
      setAuthConfirmPassword("");
      resetPortalSelection();
    } catch (error) {
      setAuthError(getErrorMessage(error));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function onForgotPasswordSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthSubmitting(true);
    setAuthError("");
    setAuthStatus("");

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: authUsername,
          password: authPassword,
          confirmPassword: authConfirmPassword,
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Reset password failed.");
      }

      setAuthStatus("Password updated successfully. Please login with the new password.");
      setForgotPasswordMode(false);
      setAuthPassword("");
      setAuthConfirmPassword("");
    } catch (error) {
      setAuthError(getErrorMessage(error));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    await clearStoredRunContext().catch(() => {});
    setAuthUser(null);
    setAuthUsername("");
    setAuthPassword("");
    setAuthConfirmPassword("");
    setAuthError("");
    setAuthStatus("");
    setForgotPasswordMode(false);
    setSettingsOpen(false);
    setActiveView("portal-selection");
    setManagedUsers([]);
    setManageError("");
    setManageStatus("");
    setNewUserEmail("");
    setTemporaryPassword("");
    setEditingUserId("");
    setEditingEmail("");
    setSelectedPortalId(null);
    setIehpLoginFile(null);
    setClaimFileHandle(null);
    setClaimFileName("");
    setAerialCredentialFile(null);
    setAerialInputFile(null);
    setIsProcessing(false);
    setStatus("");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
  }

  async function addManagedUser(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setManageError("");
    setManageStatus("");

    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newUserEmail,
          temporaryPassword,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to add user.");
      }

      setManageStatus(`User added. Temporary password: ${data.temporaryPassword}`);
      setNewUserEmail("");
      setTemporaryPassword("");
      await loadManagedUsers();
    } catch (error) {
      setManageError(getErrorMessage(error));
    }
  }

  async function updateUserEmail(userId: string) {
    setManageError("");
    setManageStatus("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: editingEmail }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to update email.");
      }
      setEditingUserId("");
      setEditingEmail("");
      setManageStatus("Employee email updated.");
      await loadManagedUsers();
    } catch (error) {
      setManageError(getErrorMessage(error));
    }
  }

  async function deactivateUser(userId: string) {
    if (!window.confirm("Deactivate this user? They will no longer be able to login.")) return;

    setManageError("");
    setManageStatus("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unable to deactivate user.");
      }
      setManageStatus("Employee deactivated.");
      await loadManagedUsers();
    } catch (error) {
      setManageError(getErrorMessage(error));
    }
  }

  async function selectClaimFile() {
    try {
      const fileHandle = await selectExcelFileHandle();
      if (!fileHandle) return null;

      setClaimFileHandle(fileHandle);
      await saveClaimFileHandle(fileHandle).catch(() => {});
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

  function handleLoginFileChange(file: File | null) {
    setIehpLoginFile(file);
    if (file) {
      void saveIehpLoginFile(file).catch(() => {});
    }
  }

  async function runIehpSession(options: {
    claimFileHandle: FileSystemFileHandle;
    loginFile: File;
    existingJobId?: string;
    initialStartIndex?: number;
    attachToRunningJob?: boolean;
    initialLogs?: string[];
    initialProgress?: JobProgressValue | null;
    allowPermissionPrompt?: boolean;
  }) {
    const workbookBundle = await loadIehpWorkbookBundle(options.claimFileHandle, {
      requestPermission: options.allowPermissionPrompt ?? true,
      fileNameForErrors: options.claimFileHandle ? claimFileName : "",
    });
    const { claimRows, totalRows, excelWb, worksheet } = workbookBundle;

    setClaimFileHandle(options.claimFileHandle);
    const liveClaimFile = await options.claimFileHandle.getFile();
    setClaimFileName(liveClaimFile.name);
    setIehpLoginFile(options.loginFile);
    await saveClaimFileHandle(options.claimFileHandle).catch(() => {});
    await saveIehpLoginFile(options.loginFile).catch(() => {});

    setIsProcessing(true);
    setLogs(options.initialLogs ?? []);
    setProgress(options.initialProgress ?? null);
    setErrorScreenshots([]);
    setStatus(
      options.attachToRunningJob
        ? "Reconnecting to current IEHP run..."
        : options.initialStartIndex && options.initialStartIndex > 0
          ? `Auto-resuming from row ${options.initialStartIndex + 1}...`
          : `Starting IEHP process for ${totalRows} rows...`,
    );

    const processChunk = async (
      startIndex: number,
      logicalJobId: string,
      mode: "attach" | "start",
    ): Promise<void> => {
      let currentCompleted = startIndex;
      let chunkHasError = false;
      let writeQueue = Promise.resolve();
      let writeFailure: Error | null = null;
      let writeFailureAlertShown = false;
      let subscribedJobId = logicalJobId;
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
              await writeWorkbookToClaimFile(options.claimFileHandle, excelWb);
            } catch (writeErr) {
              console.error("Failed to write to file:", writeErr);
              handleWriteFailure(writeErr);
            }
          });
          } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
            setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
          } else if (eventData.type === "debug_html" && typeof eventData.index === "number" && eventData.html) {
            const artifactKey = buildDownloadArtifactKey(eventData);
            if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
              downloadTextFile(`debug_dom_row_${eventData.index + 1}.html`, eventData.html, "text/html");
              rememberDownloadedArtifact(subscribedJobId, artifactKey);
            }
          } else if (eventData.type === "pdf_download" && eventData.filename && eventData.base64) {
            const artifactKey = buildDownloadArtifactKey(eventData);
            if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
              downloadBase64File(eventData.filename, eventData.base64, "application/pdf");
              rememberDownloadedArtifact(subscribedJobId, artifactKey);
            }
          } else if (eventData.type === "error" && eventData.message) {
            setStatus(`Error: ${eventData.message}`);
            chunkHasError = true;
          }
        };

      try {
        if (mode === "start") {
          const formData = new FormData();
          formData.append("portalId", "iehp");
          formData.append("loginExcel", options.loginFile);
          formData.append("loginFileName", options.loginFile.name);
          formData.append("claimFileName", liveClaimFile.name);
          formData.append("claimRows", JSON.stringify(claimRows));
          formData.append("startIndex", startIndex.toString());
          if (logicalJobId) {
            formData.append("existingJobId", logicalJobId);
          }
          subscribedJobId = await startScrapeJob(formData);
        }

        await subscribeToScrapeJobEvents({
          jobId: subscribedJobId,
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

      const effectiveJobId = subscribedJobId || logicalJobId || options.existingJobId || "";

      if (chunkHasError) {
        setIsProcessing(false);
      } else if (currentCompleted < totalRows) {
        setStatus(`Auto-resuming from row ${currentCompleted + 1}...`);
        await processChunk(currentCompleted, effectiveJobId, "start");
      } else {
        try {
          setStatus("Running post-processing (generating summary columns & duplicating rows)...");
          postProcessWorksheet(worksheet);
          await writeWorkbookToClaimFile(options.claimFileHandle, excelWb);
          setStatus("IEHP processing completed.");
          await clearStoredRunContext().catch(() => {});
        } catch (postError) {
          console.error("Post-processing failed", postError);
          setStatus(`Processing succeeded but post-processing failed: ${getErrorMessage(postError)}`);
        } finally {
          setIsProcessing(false);
        }
      }
    };

    await processChunk(options.initialStartIndex ?? 0, options.existingJobId ?? "", options.attachToRunningJob ? "attach" : "start");
  }

  async function resumeExistingIehpRun(currentJob: CurrentScrapeJob, storedClaimHandle: FileSystemFileHandle, storedLoginFile: File) {
    if (currentJob.status === "waiting_resume") {
      await runIehpSession({
        claimFileHandle: storedClaimHandle,
        loginFile: storedLoginFile,
        existingJobId: currentJob.jobId,
        initialStartIndex: currentJob.currentCompleted,
        initialLogs: currentJob.logs,
        initialProgress:
          currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null,
        allowPermissionPrompt: false,
      });
      return;
    }

    await runIehpSession({
      claimFileHandle: storedClaimHandle,
      loginFile: storedLoginFile,
      existingJobId: currentJob.jobId,
      initialStartIndex: currentJob.currentCompleted,
      attachToRunningJob: true,
      initialProgress:
        currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null,
      allowPermissionPrompt: false,
    });
  }

  async function reconnectAerialRun(currentJob: CurrentScrapeJob) {
    setIsProcessing(true);
    setSelectedPortalId("aerial");
    setLogs([]);
    setErrorScreenshots(
      (currentJob.artifacts ?? [])
        .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
        .map((artifact) => ({
          index: artifact.rowIndex ?? -1,
          image: artifact.contentBase64 ?? "",
        })),
    );
    setProgress(currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null);
    setStatus("Reconnecting to current Aerial run...");

    let hasError = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    try {
      await subscribeToScrapeJobEvents({
        jobId: currentJob.jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          if (eventData.type === "log" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
          } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
            setProgress({ completed: eventData.completed, total: eventData.total });
          } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
            setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
          } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
            const artifactKey = buildDownloadArtifactKey(eventData);
            if (!hasDownloadedArtifact(currentJob.jobId, artifactKey)) {
              downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
              rememberDownloadedArtifact(currentJob.jobId, artifactKey);
              setStatus(`Downloaded ${eventData.filename}`);
            }
          } else if (eventData.type === "warning" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
            setStatus(eventData.message);
          } else if (eventData.type === "error" && eventData.message) {
            finalErrorMessage = eventData.message;
            setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
            setStatus(`Error: ${eventData.message}`);
            hasError = true;
          }
        },
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
    } finally {
      setIsProcessing(false);
    }
  }

  async function submitIehp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!iehpLoginFile || !claimFileHandle) {
      setStatus("Please provide both required files.");
      return;
    }

    try {
      resetRunState("Reading claim file...");
      await runIehpSession({
        claimFileHandle,
        loginFile: iehpLoginFile,
      });
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
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total });
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
        const artifactKey = buildDownloadArtifactKey(eventData);
        if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
          downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
          rememberDownloadedArtifact(subscribedJobId, artifactKey);
          setStatus(`Downloaded ${eventData.filename}`);
        }
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
      subscribedJobId = jobId;
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

  if (authLoading || jobRestoreLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-slate-900">
        <div className="rounded-md border border-slate-200 bg-white px-5 py-4 text-sm font-medium shadow-sm">
          Loading...
        </div>
      </main>
    );
  }

  if (!authUser) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-slate-900">
        <div className="w-full max-w-sm rounded-md border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold">IEHP Claim Status Check</h1>

          <form className="mt-5 space-y-4" onSubmit={forgotPasswordMode ? onForgotPasswordSubmit : onAuthSubmit}>
            <div>
              <label className="mb-2 block text-sm font-medium" htmlFor="authUsername">
                Username
              </label>
              <input
                id="authUsername"
                type="text"
                autoComplete="username"
                value={authUsername}
                onChange={(event) => setAuthUsername(event.target.value)}
                className="block w-full rounded-md border border-slate-300 p-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium" htmlFor="authPassword">
                {forgotPasswordMode ? "New Password" : "Password"}
              </label>
              <input
                id="authPassword"
                type="password"
                autoComplete="current-password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                className="block w-full rounded-md border border-slate-300 p-2 text-sm"
              />
            </div>

            {forgotPasswordMode && (
              <div>
                <label className="mb-2 block text-sm font-medium" htmlFor="authConfirmPassword">
                  Confirm Password
                </label>
                <input
                  id="authConfirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={authConfirmPassword}
                  onChange={(event) => setAuthConfirmPassword(event.target.value)}
                  className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                />
              </div>
            )}

            {authError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
                {authError}
              </div>
            )}

            {authStatus && (
              <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm font-medium text-green-700">
                {authStatus}
              </div>
            )}

            <button
              type="submit"
              disabled={authSubmitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {authSubmitting ? "Please wait..." : forgotPasswordMode ? "Update Password" : "Login"}
            </button>

            <button
              type="button"
              onClick={() => {
                setForgotPasswordMode((prev) => !prev);
                setAuthError("");
                setAuthStatus("");
                setAuthPassword("");
                setAuthConfirmPassword("");
              }}
              className="w-full text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              {forgotPasswordMode ? "Back to login" : "Forgot password?"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <button
            type="button"
            onClick={resetPortalSelection}
            className="flex items-center gap-3 text-left"
          >
            <span className="flex h-10 w-16 items-center justify-center rounded-md bg-blue-600 text-sm font-bold text-white">
              IEHP
            </span>
            <span>
              <span className="block text-base font-semibold">Portal Scraper</span>
              <span className="block text-xs text-slate-500">Signed in as {authUser.email || authUser.username}</span>
            </span>
          </button>

          <div className="flex items-center gap-3">
            {effectivePortalId && (
              <button
                type="button"
                disabled={isProcessing}
                onClick={resetPortalSelection}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:text-slate-400"
              >
                Change portal
              </button>
            )}

            <div className="relative">
              <button
                type="button"
                aria-label="Settings"
                onClick={() => setSettingsOpen((open) => !open)}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 bg-white hover:bg-slate-50"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 0 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
                </svg>
              </button>

              {settingsOpen && (
                <div className="absolute right-0 z-10 mt-2 w-44 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
                  {authUser.role === "ADMIN" && (
                    <button
                      type="button"
                      onClick={openManageUsers}
                      className="block w-full px-3 py-2 text-left hover:bg-slate-50"
                    >
                      Manage Users
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={logout}
                    disabled={isProcessing}
                    className="block w-full px-3 py-2 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>

      <div className="px-4 py-12">
        {activeView === "manage-users" && authUser.role === "ADMIN" ? (
          <div className="mx-auto w-full max-w-5xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h1 className="text-xl font-semibold">Manage Users</h1>
              <button
                type="button"
                onClick={() => {
                  setActiveView("portal-selection");
                  setSettingsOpen(false);
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
              >
                Back
              </button>
            </div>

            <div className="mt-5 flex gap-2 border-b border-slate-200">
              <button
                type="button"
                onClick={() => setManageTab("add")}
                className={`px-3 py-2 text-sm font-medium ${manageTab === "add" ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-600"}`}
              >
                Add User
              </button>
              <button
                type="button"
                onClick={() => setManageTab("employees")}
                className={`px-3 py-2 text-sm font-medium ${manageTab === "employees" ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-600"}`}
              >
                Manage Employees
              </button>
            </div>

            {manageError && (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
                {manageError}
              </div>
            )}
            {manageStatus && (
              <div className="mt-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm font-medium text-green-700">
                {manageStatus}
              </div>
            )}

            {manageTab === "add" ? (
              <form className="mt-5 grid gap-4 md:grid-cols-[1fr_1fr_auto]" onSubmit={addManagedUser}>
                <div>
                  <label className="mb-2 block text-sm font-medium" htmlFor="newUserEmail">
                    Email
                  </label>
                  <input
                    id="newUserEmail"
                    type="email"
                    value={newUserEmail}
                    onChange={(event) => setNewUserEmail(event.target.value)}
                    className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium" htmlFor="temporaryPassword">
                    Temporary password
                  </label>
                  <input
                    id="temporaryPassword"
                    type="text"
                    value={temporaryPassword}
                    placeholder="Welcome123"
                    onChange={(event) => setTemporaryPassword(event.target.value)}
                    className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="submit"
                    className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    Add User
                  </button>
                </div>
              </form>
            ) : (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="px-3 py-2 font-semibold">S.No.</th>
                      <th className="px-3 py-2 font-semibold">Employee name</th>
                      <th className="px-3 py-2 font-semibold">Role</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {managedUsers.map((user, index) => (
                      <tr key={user.userId} className="border-b border-slate-100">
                        <td className="px-3 py-3">{index + 1}</td>
                        <td className="px-3 py-3">
                          {editingUserId === user.userId ? (
                            <input
                              type="email"
                              value={editingEmail}
                              onChange={(event) => setEditingEmail(event.target.value)}
                              className="w-full rounded-md border border-slate-300 p-2 text-sm"
                            />
                          ) : (
                            user.email || user.username
                          )}
                        </td>
                        <td className="px-3 py-3">{user.role}</td>
                        <td className="px-3 py-3">{user.isActive ? "Active" : "Inactive"}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            {editingUserId === user.userId ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => updateUserEmail(user.userId)}
                                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingUserId("");
                                    setEditingEmail("");
                                  }}
                                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingUserId(user.userId);
                                  setEditingEmail(user.email || user.username);
                                }}
                                disabled={!user.isActive}
                                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:text-slate-400"
                              >
                                Edit Employee Email
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => deactivateUser(user.userId)}
                              disabled={!user.isActive || user.userId === authUser.userId}
                              className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:cursor-not-allowed disabled:text-slate-400"
                            >
                              Deactivate
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            {!selectedPortal ? (
            <>
              <h1 className="text-2xl font-semibold">Select Portal</h1>
              <p className="mt-2 text-sm text-slate-600">Choose the portal scraper you want to run.</p>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                {([iehpFrontendPortalConfig, aerialFrontendPortalConfig] as const).map((portal) => (
                  <button
                    key={portal.id}
                    type="button"
                    onClick={() => {
                      setSelectedPortalId(portal.id as PortalId);
                      navigateToPortalRoute(portal.id as PortalId);
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
              <div>
                <h1 className="text-2xl font-semibold">{selectedPortal.name}</h1>
                <p className="mt-2 max-w-xl text-sm text-slate-600">{selectedPortal.description}</p>
              </div>

              {effectivePortalId === "iehp" ? (
                <>
                  <IehpInputForm
                    canSubmit={canSubmitIehp}
                    claimFileName={claimFileName}
                    isProcessing={isProcessing}
                    onLoginFileChange={handleLoginFileChange}
                    onSelectClaimFile={selectClaimFile}
                    onSubmit={submitIehp}
                  />
                  <IehpResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </>
              ) : (
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
              )}
            </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
