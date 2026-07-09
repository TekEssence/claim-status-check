"use client";

import { motion } from "framer-motion";
import { FormEvent, useEffect, useMemo, useState } from "react";
import Image, { type StaticImageData } from "next/image";
import { usePathname, useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import {
  Activity,
  CheckCheck,
  LayoutDashboard,
  LogOut,
  ShieldEllipsis,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
  Users,
  Zap,
} from "lucide-react";
import claimStatusHeroImage from "../Assets/ChatGPT Image Jun 30, 2026, 12_47_57 PM.png";
import dashboardWelcomeImage from "../Assets/ChatGPT Image Jul 1, 2026, 10_55_01 AM.png";
import blueShieldCaliforniaLogo from "../Assets/customerlogo-blue-shield-california-clr.svg";
import iehpLogo from "../Assets/channels4_profile.jpg";
import regalLogo from "../Assets/channels4_profile (1).jpg";
import availityLogo from "../Assets/availity-logo.jpg";
import { applyClaimRowUpdateToWorksheet, postProcessWorksheet } from "../portals/iehp/workbook";
import { cancelScrapeJob as cancelScrapeJobRequest, getCurrentScrapeJob, startScrapeJob, subscribeToScrapeJobEvents, submitScrapeJobInput, type CurrentScrapeJob } from "../api/scrape-jobs-api";
import { clearStoredRunContext, loadClaimFileHandle, loadIehpLoginFile, saveClaimFileHandle, saveIehpLoginFile } from "../lib/run-context-store";
import type { FileSystemFileHandle, WindowWithFilePicker } from "../types/file-system-access";
import type { ClaimRow, ErrorScreenshot, JobProgressValue, ScrapeJobEvent } from "../types/job";
import { IehpInputForm } from "../portals/iehp/IehpInputForm";
import { IehpResultView } from "../portals/iehp/IehpResultView";
import { iehpFrontendPortalConfig } from "../portals/iehp/portal-config";
import { AerialInputForm } from "../portals/aerial/AerialInputForm";
import { AerialResultView } from "../portals/aerial/AerialResultView";
import { aerialFrontendPortalConfig } from "../portals/aerial/portal-config";
import { RegalInputForm } from "../portals/regal/RegalInputForm";
import { RegalResultView } from "../portals/regal/RegalResultView";
import { regalFrontendPortalConfig } from "../portals/regal/portal-config";
import { BlueShieldInputForm } from "../portals/blue-shield/BlueShieldInputForm";
import { BlueShieldResultView } from "../portals/blue-shield/BlueShieldResultView";
import { blueShieldFrontendPortalConfig } from "../portals/blue-shield/portal-config";
import { AvailityInputForm } from "../portals/availity/AvailityInputForm";
import { AvailityResultView } from "../portals/availity/AvailityResultView";
import { availityFrontendPortalConfig } from "../portals/availity/portal-config";

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

type DashboardStatsData = {
  availablePortals: number;
  completedClaimsToday: number;
  failedJobsToday: number;
  portalsRunToday: number;
  runningJobs: number;
};

type IehpWorkbookBundle = {
  claimRows: ClaimRow[];
  totalRows: number;
  excelWb: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
};

export type PortalId = "iehp" | "aerial" | "regal" | "blue-shield" | "availity";
type DownloadFile = {
  filename: string;
  bytes: Uint8Array;
};

type DownloadableArtifact = {
  filename: string;
  base64: string;
  mimeType: string;
  completed?: number;
  total?: number;
};

const SELECTED_PORTAL_STORAGE_KEY = "iehp-selected-portal";
const SKIP_JOB_RESTORE_ONCE_KEY = "iehp-skip-job-restore-once";
const DOWNLOADED_ARTIFACTS_PREFIX = "iehp-downloaded-artifacts:";
const PORTAL_ROUTE_MAP: Record<PortalId, string> = {
  iehp: "/iehp",
  aerial: "/aerial",
  regal: "/regal",
  "blue-shield": "/blue-shield",
  availity: "/availity",
};

function isPortalId(value: string): value is PortalId {
  return value === "iehp" || value === "aerial" || value === "regal" || value === "blue-shield" || value === "availity";
}

function canRestoreCurrentJob(job: CurrentScrapeJob): job is CurrentScrapeJob & { portalId: PortalId } {
  if (!isPortalId(job.portalId)) return false;
  if (job.status === "running") return true;
  return job.portalId === "iehp" && job.status === "waiting_resume";
}
const PORTAL_UI_META: Record<
  PortalId,
  {
    shortCode: string;
    logoClassName: string;
    logoSrc?: string | StaticImageData;
    cardLogoFrameClassName?: string;
    cardLogoImageClassName?: string;
    cardLogoSize?: {
      width: number;
      height: number;
    };
    heroLogoFrameClassName?: string;
    heroLogoImageClassName?: string;
    heroLogoSize?: {
      width: number;
      height: number;
    };
  }
> = {
  iehp: {
    shortCode: "IEHP",
    logoClassName: "bg-white text-blue-700",
    logoSrc: iehpLogo,
    cardLogoFrameClassName: "h-10 w-[5.4rem] rounded-[1rem] px-1.5",
    cardLogoImageClassName: "h-full w-full scale-[2.2] object-contain",
    cardLogoSize: {
      width: 72,
      height: 28,
    },
    heroLogoFrameClassName: "h-14 w-[7.6rem] rounded-[1.15rem] px-2.5",
    heroLogoImageClassName: "h-full w-full scale-[2.2] object-contain",
    heroLogoSize: {
      width: 104,
      height: 40,
    },
  },
  aerial: {
    shortCode: "AC",
    logoClassName: "bg-[linear-gradient(180deg,#e0ecff_0%,#c7ddff_100%)] text-blue-700",
  },
  regal: {
    shortCode: "RP",
    logoClassName: "bg-white text-violet-700",
    logoSrc: regalLogo,
    cardLogoFrameClassName: "h-11 w-11 rounded-[1.1rem] p-0.5",
    cardLogoImageClassName: "h-full w-full scale-[1.08] rounded-[1rem] object-cover",
    cardLogoSize: {
      width: 44,
      height: 44,
    },
    heroLogoFrameClassName: "h-16 w-16 rounded-[1.35rem] p-0.5",
    heroLogoImageClassName: "h-full w-full scale-[1.08] rounded-[1.2rem] object-cover",
    heroLogoSize: {
      width: 64,
      height: 64,
    },
  },
  "blue-shield": {
    shortCode: "BS",
    logoClassName: "bg-white text-blue-700",
    logoSrc: blueShieldCaliforniaLogo,
    cardLogoFrameClassName: "h-10 w-[4.4rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-5 w-full object-contain",
    cardLogoSize: {
      width: 56,
      height: 20,
    },
    heroLogoFrameClassName: "h-14 w-[6.25rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-7 w-full object-contain",
    heroLogoSize: {
      width: 84,
      height: 28,
    },
  },
  availity: {
    shortCode: "AV",
    logoClassName: "bg-white text-sky-700",
    logoSrc: availityLogo,
    cardLogoFrameClassName: "h-10 w-[5.2rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-6 w-full object-contain",
    cardLogoSize: {
      width: 72,
      height: 24,
    },
    heroLogoFrameClassName: "h-14 w-[7rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-8 w-full object-contain",
    heroLogoSize: {
      width: 96,
      height: 32,
    },
  },
};

const PORTAL_WORKSPACE_META: Record<
  PortalId,
  {
    heroDescription: string;
    processingDescription: string;
  }
> = {
  iehp: {
    heroDescription: "Upload your login workbook and claim workbook to begin automated claim status verification with live workbook updates.",
    processingDescription: "Your files are validated before processing and the linked workbook is updated in place as claim checks complete.",
  },
  aerial: {
    heroDescription: "Upload your login workbook and claim details workbook to begin automated claim status verification.",
    processingDescription: "The platform validates workbook structure, secures the upload, and starts payer automation with live status tracking.",
  },
  regal: {
    heroDescription: "Upload the Regal workbook package to start a guided automation workflow with secure validation and live progress tracking.",
    processingDescription: "If needed, you can override environment credentials and continue the Regal flow with secure OTP-assisted verification.",
  },
  "blue-shield": {
    heroDescription: "Upload your login workbook and input workbook to begin Blue Shield claim status verification grouped by member-ready processing.",
    processingDescription: "Blue Shield requests are validated by group, encrypted during upload, and processed with checkpoint-aware automation.",
  },
  availity: {
    heroDescription: "Upload your Availity login workbook and claim workbook to process Aetna, Blue Cross Blue Shield, and Wellpoint claim status checks.",
    processingDescription: "Availity requests stream live status over SSE and automatically download the completed output workbook.",
  },
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

function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getZipDateTime(date = new Date()): { zipDate: number; zipTime: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    zipDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    zipTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function createZip(files: DownloadFile[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const { zipDate, zipTime } = getZipDateTime();

  for (const file of files) {
    const filenameBytes = textToBytes(file.filename.replace(/\\/g, "/"));
    const checksum = crc32(file.bytes);

    const localHeader = new Uint8Array(30 + filenameBytes.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, zipTime);
    writeUint16(localHeader, 12, zipDate);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, file.bytes.length);
    writeUint32(localHeader, 22, file.bytes.length);
    writeUint16(localHeader, 26, filenameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(filenameBytes, 30);

    localParts.push(localHeader, file.bytes);

    const centralHeader = new Uint8Array(46 + filenameBytes.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, zipTime);
    writeUint16(centralHeader, 14, zipDate);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, file.bytes.length);
    writeUint32(centralHeader, 24, file.bytes.length);
    writeUint16(centralHeader, 28, filenameBytes.length);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, offset);
    centralHeader.set(filenameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + file.bytes.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const endRecord = new Uint8Array(22);
  writeUint32(endRecord, 0, 0x06054b50);
  writeUint16(endRecord, 4, 0);
  writeUint16(endRecord, 6, 0);
  writeUint16(endRecord, 8, files.length);
  writeUint16(endRecord, 10, files.length);
  writeUint32(endRecord, 12, centralDirectory.length);
  writeUint32(endRecord, 16, offset);
  writeUint16(endRecord, 20, 0);

  return concatBytes([...localParts, centralDirectory, endRecord]);
}

function downloadZip(filename: string, files: DownloadFile[]): void {
  if (!files.length) return;
  const zipBytes = createZip(files);
  const arrayBuffer = zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength) as ArrayBuffer;
  downloadBlob(filename, new Blob([arrayBuffer], { type: "application/zip" }));
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
  return `Please click Allow And Continue to allow access to the same claim Excel${fileName ? ` (${fileName})` : ""} and continue the previous IEHP run.`;
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
  const [activeView, setActiveView] = useState<"portal-selection" | "manage-users" | "reset-password">("portal-selection");
  const [manageTab, setManageTab] = useState<"add" | "employees">("add");
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [manageError, setManageError] = useState("");
  const [manageStatus, setManageStatus] = useState("");
  const [portalSearch, setPortalSearch] = useState("");
  const [portalFilter, setPortalFilter] = useState<"all" | PortalId>("all");
  const [portalSort, setPortalSort] = useState<"name-asc" | "name-desc">("name-asc");
  const [portalLayout, setPortalLayout] = useState<"grid" | "list">("grid");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [editingUserId, setEditingUserId] = useState("");
  const [editingEmail, setEditingEmail] = useState("");
  const [settingsPassword, setSettingsPassword] = useState("");
  const [settingsConfirmPassword, setSettingsConfirmPassword] = useState("");
  const [settingsPasswordError, setSettingsPasswordError] = useState("");
  const [settingsPasswordStatus, setSettingsPasswordStatus] = useState("");
  const [settingsPasswordSubmitting, setSettingsPasswordSubmitting] = useState(false);
  const [selectedPortalId, setSelectedPortalId] = useState<PortalId | null>(null);
  const [iehpLoginFile, setIehpLoginFile] = useState<File | null>(null);
  const [claimFileHandle, setClaimFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [claimFileName, setClaimFileName] = useState<string>("");
  const [aerialCredentialFile, setAerialCredentialFile] = useState<File | null>(null);
  const [aerialInputFile, setAerialInputFile] = useState<File | null>(null);
  const [availityCredentialFile, setAvailityCredentialFile] = useState<File | null>(null);
  const [availityInputFile, setAvailityInputFile] = useState<File | null>(null);
  const [blueShieldCredentialFile, setBlueShieldCredentialFile] = useState<File | null>(null);
  const [blueShieldInputFile, setBlueShieldInputFile] = useState<File | null>(null);
  const [blueShieldGroup, setBlueShieldGroup] = useState("");
  const [blueShieldResetCheckpoint, setBlueShieldResetCheckpoint] = useState(false);
  const [blueShieldJobId, setBlueShieldJobId] = useState<string>("");
  const [blueShieldOtpRequest, setBlueShieldOtpRequest] = useState<{ inputName: string; label: string; message: string } | null>(null);
  const [blueShieldOtpValue, setBlueShieldOtpValue] = useState<string>("");
  const [regalLoginFile, setRegalLoginFile] = useState<File | null>(null);
  const [regalClaimFile, setRegalClaimFile] = useState<File | null>(null);
  const [regalJobId, setRegalJobId] = useState<string>("");
  const [regalMfaRequest, setRegalMfaRequest] = useState<{
    inputName: string;
    label: string;
    message: string;
    options: NonNullable<ScrapeJobEvent["options"]>;
  } | null>(null);
  const [regalMfaValue, setRegalMfaValue] = useState<string>("");
  const [regalOtpRequest, setRegalOtpRequest] = useState<{ inputName: string; label: string; message: string } | null>(null);
  const [regalOtpValue, setRegalOtpValue] = useState<string>("");
  const [latestRegalOutput, setLatestRegalOutput] = useState<DownloadableArtifact | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCancellingJob, setIsCancellingJob] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorScreenshots, setErrorScreenshots] = useState<ErrorScreenshot[]>([]);
  const [progress, setProgress] = useState<JobProgressValue | null>(null);
  const [activeJobId, setActiveJobId] = useState<string>("");
  const [jobRestoreLoading, setJobRestoreLoading] = useState(true);
  const [pendingIehpRestoreJob, setPendingIehpRestoreJob] = useState<CurrentScrapeJob | null>(null);
  const [pendingRegalRestoreJob, setPendingRegalRestoreJob] = useState<CurrentScrapeJob | null>(null);
  const [pendingBlueShieldRestoreJob, setPendingBlueShieldRestoreJob] = useState<CurrentScrapeJob | null>(null);
  const [dashboardStatsData, setDashboardStatsData] = useState<DashboardStatsData>({
    availablePortals: 0,
    completedClaimsToday: 0,
    failedJobsToday: 0,
    portalsRunToday: 0,
    runningJobs: 0,
  });

  const isProtectedRoute = pathname !== "/";
  const effectivePortalId = forcedPortalId ?? selectedPortalId;
  const availablePortals = useMemo(
    () => [iehpFrontendPortalConfig, aerialFrontendPortalConfig, regalFrontendPortalConfig, blueShieldFrontendPortalConfig, availityFrontendPortalConfig] as const,
    [],
  );
  const selectedPortal =
    effectivePortalId === "iehp"
      ? iehpFrontendPortalConfig
      : effectivePortalId === "aerial"
        ? aerialFrontendPortalConfig
        : effectivePortalId === "regal"
          ? regalFrontendPortalConfig
          : effectivePortalId === "blue-shield"
            ? blueShieldFrontendPortalConfig
            : effectivePortalId === "availity"
              ? availityFrontendPortalConfig
            : null;
  const selectedPortalUiMeta = effectivePortalId ? PORTAL_UI_META[effectivePortalId] : null;
  const filteredPortals = useMemo(() => {
    const normalizedQuery = portalSearch.trim().toLowerCase();
    const matches = availablePortals.filter((portal) => {
      const matchesSearch =
        !normalizedQuery ||
        `${portal.name} ${portal.description} ${portal.id}`.toLowerCase().includes(normalizedQuery);
      const matchesFilter = portalFilter === "all" || portal.id === portalFilter;
      return matchesSearch && matchesFilter;
    });

    return [...matches].sort((left, right) =>
      portalSort === "name-asc"
        ? left.name.localeCompare(right.name)
        : right.name.localeCompare(left.name),
    );
  }, [availablePortals, portalFilter, portalSearch, portalSort]);
  const recentPortals = useMemo(() => availablePortals.slice(0, 4), [availablePortals]);
  const userDisplayName = useMemo(() => {
    const raw = authUser?.email || authUser?.username || "Afrin";
    const candidate = raw.split("@")[0].replace(/[._-]+/g, " ").trim();
    return candidate
      .split(" ")
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
  }, [authUser]);
  const userInitials = useMemo(
    () =>
      userDisplayName
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase(),
    [userDisplayName],
  );
  const canSubmitIehp = useMemo(
    () => Boolean(iehpLoginFile && claimFileHandle && !isProcessing),
    [iehpLoginFile, claimFileHandle, isProcessing],
  );
  const canSubmitAerial = useMemo(
    () => Boolean(aerialInputFile && !isProcessing),
    [aerialInputFile, isProcessing],
  );
  const canSubmitAvaility = useMemo(
    () => Boolean(availityCredentialFile && availityInputFile && !isProcessing),
    [availityCredentialFile, availityInputFile, isProcessing],
  );
  const canSubmitRegal = useMemo(
    () => Boolean(regalClaimFile && !isProcessing),
    [regalClaimFile, isProcessing],
  );
  const canSubmitBlueShield = useMemo(
    () => Boolean(blueShieldCredentialFile && blueShieldInputFile && blueShieldGroup && !isProcessing),
    [blueShieldCredentialFile, blueShieldInputFile, blueShieldGroup, isProcessing],
  );
  const currentCanSubmit =
    effectivePortalId === "iehp"
      ? canSubmitIehp
      : effectivePortalId === "aerial"
        ? canSubmitAerial
        : effectivePortalId === "regal"
          ? canSubmitRegal
          : effectivePortalId === "blue-shield"
            ? canSubmitBlueShield
            : effectivePortalId === "availity"
              ? canSubmitAvaility
            : false;
  const portalWorkflowMeta = effectivePortalId ? PORTAL_WORKSPACE_META[effectivePortalId] : null;
  const portalFileState = useMemo(() => {
    if (effectivePortalId === "iehp") {
      return {
        claimFileLabel: claimFileName,
        claimReady: Boolean(claimFileName),
        loginFileLabel: iehpLoginFile?.name ?? "",
        loginReady: Boolean(iehpLoginFile),
      };
    }

    if (effectivePortalId === "aerial") {
      return {
        claimFileLabel: aerialInputFile?.name ?? "",
        claimReady: Boolean(aerialInputFile),
        loginFileLabel: aerialCredentialFile?.name ?? "",
        loginReady: Boolean(aerialCredentialFile),
      };
    }

    if (effectivePortalId === "regal") {
      return {
        claimFileLabel: regalClaimFile?.name ?? "",
        claimReady: Boolean(regalClaimFile),
        loginFileLabel: regalLoginFile?.name ?? "",
        loginReady: Boolean(regalLoginFile),
      };
    }

    if (effectivePortalId === "availity") {
      return {
        claimFileLabel: availityInputFile?.name ?? "",
        claimReady: Boolean(availityInputFile),
        loginFileLabel: availityCredentialFile?.name ?? "",
        loginReady: Boolean(availityCredentialFile),
      };
    }

    if (effectivePortalId === "blue-shield") {
      return {
        claimFileLabel: blueShieldInputFile?.name ?? "",
        claimReady: Boolean(blueShieldInputFile),
        loginFileLabel: blueShieldCredentialFile?.name ?? "",
        loginReady: Boolean(blueShieldCredentialFile),
      };
    }

    return {
      claimFileLabel: "",
      claimReady: false,
      loginFileLabel: "",
      loginReady: false,
    };
  }, [
    aerialCredentialFile,
    aerialInputFile,
    availityCredentialFile,
    availityInputFile,
    blueShieldCredentialFile,
    blueShieldInputFile,
    claimFileName,
    effectivePortalId,
    iehpLoginFile,
    regalClaimFile,
    regalLoginFile,
  ]);
  const portalWorkflowStepIndex = useMemo(() => {
    const normalizedStatus = status.toLowerCase();
    const isCompleted =
      !isProcessing &&
      Boolean(status.trim()) &&
      /(complete|completed|success|finished|done|saved|updated)/i.test(normalizedStatus);

    if (isCompleted) return 4;
    if (isProcessing) return 3;
    if (currentCanSubmit) return 2;
    if (portalFileState.claimReady) return 1;
    return 0;
  }, [currentCanSubmit, isProcessing, portalFileState.claimReady, status]);
  const hasCompletedRun = useMemo(
    () => !isProcessing && Boolean(status.trim()) && /(complete|completed|success|finished|done|saved|updated)/i.test(status.toLowerCase()),
    [isProcessing, status],
  );
  const portalWorkflowSteps = [
    "Upload Login File",
    "Upload Claim File",
    "Validate Files",
    "Processing",
    "Completed",
  ];

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
    if (!authLoading && !authUser && isProtectedRoute) {
      router.replace("/");
    }
  }, [authLoading, authUser, isProtectedRoute, router]);

  useEffect(() => {
    if (!authUser) {
      setJobRestoreLoading(false);
      return;
    }

    try {
      if (window.sessionStorage.getItem(SKIP_JOB_RESTORE_ONCE_KEY) === "true") {
        window.sessionStorage.removeItem(SKIP_JOB_RESTORE_ONCE_KEY);
        setJobRestoreLoading(false);
        return;
      }
    } catch {
      // Ignore storage failures.
    }

    let cancelled = false;

    const restoreCurrentRun = async () => {
      try {
        const currentJob = await getCurrentScrapeJob();
        if (cancelled || !currentJob) return;
        if (!canRestoreCurrentJob(currentJob)) return;

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
        setActiveView("portal-selection");

        if (currentJob.portalId === "blue-shield") {
          setActiveJobId(currentJob.jobId);
          setPendingBlueShieldRestoreJob(currentJob);
          setSelectedPortalId("blue-shield");
          setIsProcessing(false);
          setStatus("A previous Blue Shield run is still active. Click Start processing to replace it, or Cancel Processing to stop it.");
          return;
        }

        setStatus(`Reconnected to ${currentJob.portalId.toUpperCase()} run in progress...`);
        setIsProcessing(true);
        setActiveJobId(currentJob.jobId);
        setSelectedPortalId(currentJob.portalId as PortalId);
        navigateToPortalRoute(currentJob.portalId as PortalId);
        setActiveView("portal-selection");

        if (currentJob.portalId === "iehp") {
          const [storedClaimHandle, storedLoginFile] = await Promise.all([loadClaimFileHandle(), loadIehpLoginFile()]);
          if (cancelled) return;
          let canAutoResumeIehp = true;

          if (storedClaimHandle) {
            setClaimFileHandle(storedClaimHandle);
            setClaimFileName(currentJob.claimFileName || "");
            const currentPermission = await storedClaimHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as const);
            if (currentPermission !== "granted") {
              canAutoResumeIehp = false;
            }
          }
          if (storedLoginFile) {
            setIehpLoginFile(storedLoginFile);
          }

          if (storedClaimHandle && storedLoginFile && canAutoResumeIehp) {
            await resumeExistingIehpRun(currentJob, storedClaimHandle, storedLoginFile);
          } else {
            setPendingIehpRestoreJob(currentJob);
            if (!storedClaimHandle) {
              setStatus(`Could not restore the active run: ${getMissingLocalExcelMessage(currentJob.claimFileName)}`);
            } else if (!canAutoResumeIehp) {
              const normalizedResumeMessage = `Previous IEHP run restored. Click Allow And Continue to continue from row ${currentJob.currentCompleted + 1}.`;
              setStatus(normalizedResumeMessage);
              if (typeof window !== "undefined") {
                window.alert(normalizedResumeMessage);
              }
            } else {
              setStatus("A run is active, but the local IEHP login file context could not be restored automatically. Please upload the login file again if needed.");
            }
            setIsProcessing(false);
          }
        } else if (currentJob.portalId === "aerial") {
          await reconnectAerialRun(currentJob);
        } else if (currentJob.portalId === "availity") {
          await reconnectDownloadOnlyRun(currentJob, "availity", "Availity");
        } else if (currentJob.portalId === "regal") {
          await reconnectRegalRun(currentJob);
        }
      } catch (error) {
        if (!cancelled) {
          if (isFileAccessPermissionError(error) || getErrorMessage(error).includes("Browser file permission is not currently granted")) {
            const currentJob = await getCurrentScrapeJob().catch(() => null);
            if (currentJob?.portalId === "iehp") {
              setPendingIehpRestoreJob(currentJob);
            }
          }
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
    if (!authUser) {
      return;
    }

    if (authUser.mustResetPassword) {
      setSettingsOpen(false);
      setSelectedPortalId(null);
      setActiveView("reset-password");
      return;
    }

    if (activeView === "reset-password") {
      setActiveView("portal-selection");
    }
  }, [authUser, activeView]);

  useEffect(() => {
    if (forcedPortalId) {
      setSelectedPortalId(forcedPortalId);
      return;
    }

    if (!authUser || authUser.mustResetPassword || selectedPortalId) {
      return;
    }

    try {
      const storedPortalId = window.localStorage.getItem(SELECTED_PORTAL_STORAGE_KEY);
      if (storedPortalId && isPortalId(storedPortalId)) {
        setSelectedPortalId(storedPortalId);
        navigateToPortalRoute(storedPortalId);
      }
    } catch {
      // Ignore storage failures.
    }
  }, [authUser, selectedPortalId, forcedPortalId]);

  useEffect(() => {
    if (!authUser) {
      setDashboardStatsData({
        availablePortals: availablePortals.length,
        completedClaimsToday: 0,
        failedJobsToday: 0,
        portalsRunToday: 0,
        runningJobs: 0,
      });
      return;
    }

    let cancelled = false;

    fetch("/api/dashboard/stats")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load dashboard stats: ${response.status}`);
        }
        const data = (await response.json()) as { stats?: DashboardStatsData };
        if (!cancelled && data.stats) {
          setDashboardStatsData(data.stats);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDashboardStatsData((current) => ({
            ...current,
            availablePortals: availablePortals.length,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authUser, availablePortals.length]);

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
    setIsCancellingJob(false);
    setStatus(message);
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
    setActiveJobId("");
    setRegalJobId("");
    setRegalMfaRequest(null);
    setRegalMfaValue("");
    setRegalOtpRequest(null);
    setRegalOtpValue("");
    setBlueShieldJobId("");
    setBlueShieldOtpRequest(null);
    setBlueShieldOtpValue("");
    setLatestRegalOutput(null);
  }

  function resetPortalSelection() {
    setActiveView("portal-selection");
    setSettingsOpen(false);
    if (forcedPortalId) {
      try {
        window.localStorage.removeItem(SELECTED_PORTAL_STORAGE_KEY);
        window.sessionStorage.setItem(SKIP_JOB_RESTORE_ONCE_KEY, "true");
      } catch {
        // Ignore storage failures.
      }
      router.push("/");
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
    setIsProcessing(false);
    setIsCancellingJob(false);
    setActiveJobId("");
    setPendingIehpRestoreJob(null);
    setPendingBlueShieldRestoreJob(null);
    setRegalJobId("");
    setRegalMfaRequest(null);
    setRegalMfaValue("");
    setRegalOtpRequest(null);
    setRegalOtpValue("");
    setBlueShieldJobId("");
    setBlueShieldOtpRequest(null);
    setBlueShieldOtpValue("");
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
    setActiveView("manage-users");
    setManageStatus("");
    try {
      await loadManagedUsers();
    } catch (error) {
      setManageError(getErrorMessage(error));
    }
  }

  async function openResetPassword() {
    setActiveView("reset-password");
    setSettingsPassword("");
    setSettingsConfirmPassword("");
    setSettingsPasswordError("");
    setSettingsPasswordStatus("");
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

      const nextUser = data.user ?? null;
      setAuthUser(nextUser);
      setAuthUsername("");
      setAuthPassword("");
      setAuthConfirmPassword("");
      if (nextUser?.mustResetPassword) {
        setSelectedPortalId(null);
        setSettingsOpen(false);
        setForgotPasswordMode(false);
        setActiveView("reset-password");
        setAuthStatus("Please update your password before continuing.");
      } else {
        resetPortalSelection();
      }
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
    setActiveView("portal-selection");
    setManagedUsers([]);
    setManageError("");
    setManageStatus("");
    setNewUserEmail("");
    setTemporaryPassword("");
    setEditingUserId("");
    setEditingEmail("");
    setSettingsPassword("");
    setSettingsConfirmPassword("");
    setSettingsPasswordError("");
    setSettingsPasswordStatus("");
    setSettingsPasswordSubmitting(false);
    setSelectedPortalId(null);
    setIehpLoginFile(null);
    setClaimFileHandle(null);
    setClaimFileName("");
    setAerialCredentialFile(null);
    setAerialInputFile(null);
    setBlueShieldCredentialFile(null);
    setBlueShieldInputFile(null);
    setBlueShieldGroup("");
    setBlueShieldResetCheckpoint(false);
    setBlueShieldJobId("");
    setBlueShieldOtpRequest(null);
    setBlueShieldOtpValue("");
    setIsProcessing(false);
    setIsCancellingJob(false);
    setStatus("");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
    setActiveJobId("");
    setPendingIehpRestoreJob(null);
    setPendingBlueShieldRestoreJob(null);
  }

  async function cancelActiveJob() {
    const jobId = pendingBlueShieldRestoreJob?.jobId || pendingIehpRestoreJob?.jobId || activeJobId || regalJobId;
    if (!jobId || isCancellingJob) return;

    setIsCancellingJob(true);
    setStatus("Cancelling current processing run...");

    try {
      await cancelScrapeJobRequest(jobId);
      setPendingBlueShieldRestoreJob(null);
      setPendingIehpRestoreJob(null);
      setActiveJobId("");
      setRegalJobId("");
      setRegalOtpRequest(null);
      setRegalOtpValue("");
      setIsProcessing(false);
      setStatus("Processing cancelled.");
      await clearStoredRunContext().catch(() => {});
    } catch (error) {
      setStatus(`Failed to cancel processing: ${getErrorMessage(error)}`);
    } finally {
      setIsCancellingJob(false);
    }
  }

  function resetBlueShieldWorkflow() {
    setBlueShieldCredentialFile(null);
    setBlueShieldInputFile(null);
    setBlueShieldResetCheckpoint(false);
    setStatus("");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
    setActiveJobId("");
    setPendingBlueShieldRestoreJob(null);
    setIsProcessing(false);
    setIsCancellingJob(false);
  }

  async function resetPasswordFromSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSettingsPasswordSubmitting(true);
    setSettingsPasswordError("");
    setSettingsPasswordStatus("");

    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: settingsPassword,
          confirmPassword: settingsConfirmPassword,
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Password reset failed.");
      }

      const nextUser = data.user ?? authUser;
      setAuthUser(nextUser);
      setSettingsPassword("");
      setSettingsConfirmPassword("");
      setSettingsPasswordStatus("Password updated successfully.");
      if (nextUser && !nextUser.mustResetPassword) {
        setActiveView("portal-selection");
      }
    } catch (error) {
      setSettingsPasswordError(getErrorMessage(error));
    } finally {
      setSettingsPasswordSubmitting(false);
    }
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

      if (pendingIehpRestoreJob) {
        const loginFileToUse = iehpLoginFile ?? (await loadIehpLoginFile().catch(() => null));
        if (!loginFileToUse) {
          setStatus("The active IEHP run is waiting, but the login file could not be restored. Please upload the login file again.");
          return fileHandle;
        }

        setIehpLoginFile(loginFileToUse);
        setPendingIehpRestoreJob(null);
        void resumeExistingIehpRun(pendingIehpRestoreJob, fileHandle, loginFileToUse).catch((error) => {
          setPendingIehpRestoreJob(pendingIehpRestoreJob);
          setStatus(`Could not restore the active run: ${getErrorMessage(error)}`);
          setIsProcessing(false);
        });
      }

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
    setActiveJobId(options.existingJobId ?? "");
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
      let cancellationRequested = false;
      const streamAbortController = new AbortController();

      const handleWriteFailure = (error: unknown): never => {
        const message = getErrorMessage(error);
        const userMessage = `Excel update failed. The workbook may be open, locked, moved, or browser file permission may have been lost. Please close Excel, verify file access, and run again. Some recent updates may not have been saved. Details: ${message}`;
        const failure = new Error(userMessage);
        writeFailure = failure;
        chunkHasError = true;
        setStatus(`Error: ${userMessage}`);
        streamAbortController.abort();
        if (!cancellationRequested && subscribedJobId) {
          cancellationRequested = true;
          void cancelScrapeJobRequest(subscribedJobId).catch((cancelError) => {
            console.error("Failed to cancel scrape job after Excel write failure", cancelError);
          });
        }
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
          } else if (eventData.type === "cancelled") {
            cancellationRequested = true;
            chunkHasError = true;
            setStatus(eventData.message || "Processing cancelled.");
            setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
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
          setActiveJobId(subscribedJobId);
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
          setActiveJobId("");
        }
      }
    };

    await processChunk(options.initialStartIndex ?? 0, options.existingJobId ?? "", options.attachToRunningJob ? "attach" : "start");
    setActiveJobId("");
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
    });
  }

  async function reconnectAerialRun(currentJob: CurrentScrapeJob) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
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
    let wasCancelled = false;
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
          } else if (eventData.type === "cancelled") {
            wasCancelled = true;
            setStatus(eventData.message || "Processing cancelled.");
            setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
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
        wasCancelled
          ? "Aerial processing cancelled."
          : hasError
          ? `Aerial processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Aerial processing completed.",
      );
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function reconnectDownloadOnlyRun(currentJob: CurrentScrapeJob, portalId: PortalId, portalName: string) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
    setSelectedPortalId(portalId);
    setLogs(currentJob.logs ?? []);
    setErrorScreenshots(
      (currentJob.artifacts ?? [])
        .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
        .map((artifact) => ({
          index: artifact.rowIndex ?? -1,
          image: artifact.contentBase64 ?? "",
        })),
    );
    setProgress(currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null);
    setStatus(`Reconnecting to current ${portalName} run...`);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
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
          } else if (eventData.type === "cancelled") {
            wasCancelled = true;
            setStatus(eventData.message || "Processing cancelled.");
            setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
          }
        },
        onStreamError(error) {
          console.error(`${portalName} stream error:`, error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });

      setStatus(
        wasCancelled
          ? `${portalName} processing cancelled.`
          : hasError
          ? `${portalName} processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : `${portalName} processing completed.`,
      );
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }



  async function reconnectBlueShieldRun(currentJob: CurrentScrapeJob) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
    setPendingBlueShieldRestoreJob(null);
    setSelectedPortalId("blue-shield");
    setBlueShieldJobId(currentJob.jobId);
    setLogs(currentJob.logs ?? []);
    setErrorScreenshots(
      (currentJob.artifacts ?? [])
        .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
        .map((artifact) => ({
          index: artifact.rowIndex ?? -1,
          image: artifact.contentBase64 ?? "",
        })),
    );
    setProgress(currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null);
    setStatus("Reconnecting to current Blue Shield run...");

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
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
          } else if (eventData.type === "input_request" && eventData.inputName) {
            setBlueShieldOtpRequest({
              inputName: eventData.inputName,
              label: eventData.label || "Enter verification code",
              message: eventData.message || "Enter the verification code sent by Blue Shield.",
            });
            setBlueShieldOtpValue("");
            setStatus(eventData.message || "Waiting for Blue Shield verification code.");
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
          } else if (eventData.type === "cancelled") {
            wasCancelled = true;
            setStatus(eventData.message || "Processing cancelled.");
            setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
          }
        },
        onStreamError(error) {
          console.error("Blue Shield stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });

      setStatus(
        wasCancelled
          ? "Blue Shield processing cancelled."
          : hasError
          ? `Blue Shield processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Blue Shield processing completed.",
      );
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function reconnectRegalRun(currentJob: CurrentScrapeJob) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
    setSelectedPortalId("regal");
    setRegalJobId(currentJob.jobId);
    setLogs(currentJob.logs ?? []);
    setErrorScreenshots(
      (currentJob.artifacts ?? [])
        .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
        .map((artifact) => ({
          index: artifact.rowIndex ?? -1,
          image: artifact.contentBase64 ?? "",
        })),
    );
    for (const artifact of currentJob.artifacts ?? []) {
      if (artifact.artifactType !== "file_download" || !artifact.contentBase64 || !artifact.filename) continue;
      if (artifact.filename === "regal_output.xlsx") {
        setLatestRegalOutput({
          filename: artifact.filename,
          base64: artifact.contentBase64,
          mimeType: artifact.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          completed: currentJob.currentCompleted,
          total: currentJob.totalRows,
        });
      }
      const artifactKey = `restored|${artifact.id}|${artifact.filename}|${artifact.pathOrKey}`;
      if (!hasDownloadedArtifact(currentJob.jobId, artifactKey)) {
        downloadBase64File(artifact.filename, artifact.contentBase64, artifact.mimeType || "application/octet-stream");
        rememberDownloadedArtifact(currentJob.jobId, artifactKey);
      }
    }
    const latestSnapshot = [...(currentJob.artifacts ?? [])]
      .reverse()
      .find((artifact) => artifact.artifactType === "output_snapshot" && artifact.contentBase64 && artifact.filename);
    if (latestSnapshot?.contentBase64 && latestSnapshot.filename) {
      setLatestRegalOutput({
        filename: latestSnapshot.filename,
        base64: latestSnapshot.contentBase64,
        mimeType: latestSnapshot.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        completed: currentJob.currentCompleted,
        total: currentJob.totalRows,
      });
    }
    setProgress(currentJob.totalRows > 0 ? { completed: currentJob.currentCompleted, total: currentJob.totalRows } : null);
    setStatus("Reconnecting to current Regal run...");

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    const diagnosticFiles: DownloadFile[] = [];
    const streamAbortController = new AbortController();

    try {
      if (currentJob.status === "waiting_resume") {
        if (!regalClaimFile) {
          setPendingRegalRestoreJob(currentJob);
          setStatus(`Previous Regal run paused at row ${currentJob.currentCompleted + 1}. Reselect the same Regal claim Excel and login Excel, then start again to continue.`);
          return;
        }

        const formData = new FormData();
        formData.append("portalId", "regal");
        formData.append("existingJobId", currentJob.jobId);
        formData.append("startIndex", String(currentJob.currentCompleted));
        if (regalLoginFile) {
          formData.append("loginExcel", regalLoginFile);
          formData.append("loginFileName", regalLoginFile.name);
        }
        formData.append("claimExcel", regalClaimFile);
        formData.append("claimFileName", regalClaimFile.name);
        await startScrapeJob(formData);
      }

      await subscribeToScrapeJobEvents({
        jobId: currentJob.jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          await handleRegalJobEvent(eventData, currentJob.jobId, (message) => {
            finalErrorMessage = message;
            hasError = true;
          }, diagnosticFiles);
          if (eventData.type === "cancelled") {
            wasCancelled = true;
          }
        },
        onStreamError(error) {
          console.error("Regal stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      downloadZip(`regal-diagnostics-${currentJob.jobId}.zip`, diagnosticFiles);

      setStatus(
        wasCancelled
          ? "Regal processing cancelled."
          : hasError
          ? `Regal processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Regal processing completed.",
      );
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function handleRegalJobEvent(
    eventData: ScrapeJobEvent,
    jobId: string,
    onError: (message: string) => void,
    diagnosticFiles?: DownloadFile[],
  ) {
    if (eventData.type === "log" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
    } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
      setProgress({ completed: eventData.completed, total: eventData.total });
    } else if (eventData.type === "input_request" && eventData.inputName) {
      if (eventData.inputName === "regal_mfa_method") {
        const options = eventData.options ?? [];
        setRegalMfaRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Select Regal verification method",
          message: eventData.message || "Choose one available verification method.",
          options,
        });
        setRegalMfaValue(options.find((option) => !option.disabled)?.value ?? "");
      } else {
        setRegalOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Enter verification code",
          message: eventData.message || "Enter the verification code sent by Regal/Okta.",
        });
        setRegalOtpValue("");
      }
      setStatus(eventData.message || (eventData.inputName === "regal_mfa_method" ? "Waiting for Regal verification method selection." : "Waiting for Regal verification code."));
    } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
      setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (diagnosticFiles && !hasDownloadedArtifact(jobId, artifactKey)) {
        diagnosticFiles.push({
          filename: eventData.filename || `regal_error_screenshot_${eventData.index + 1}.jpg`,
          bytes: base64ToBytes(eventData.image),
        });
        rememberDownloadedArtifact(jobId, artifactKey);
      }
    } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
      if (eventData.filename === "regal_output.xlsx") {
        setLatestRegalOutput({
          filename: eventData.filename,
          base64: eventData.base64,
          mimeType: eventData.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          completed: eventData.completed,
          total: eventData.total,
        });
      }
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (!hasDownloadedArtifact(jobId, artifactKey)) {
        downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
        rememberDownloadedArtifact(jobId, artifactKey);
        setStatus(`Downloaded ${eventData.filename}`);
      }
    } else if (eventData.type === "output_snapshot" && eventData.filename && eventData.base64) {
      setLatestRegalOutput({
        filename: eventData.filename,
        base64: eventData.base64,
        mimeType: eventData.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        completed: eventData.completed,
        total: eventData.total,
      });
    } else if (eventData.type === "debug_html" && typeof eventData.index === "number" && eventData.html) {
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (diagnosticFiles && !hasDownloadedArtifact(jobId, artifactKey)) {
        diagnosticFiles.push({
          filename: eventData.filename || `regal_error_page_${eventData.index + 1}.html`,
          bytes: textToBytes(eventData.html),
        });
        rememberDownloadedArtifact(jobId, artifactKey);
      }
    } else if (eventData.type === "warning" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
      setStatus(eventData.message);
    } else if (eventData.type === "cancelled" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
      setStatus(eventData.message);
    } else if (eventData.type === "error" && eventData.message) {
      onError(eventData.message);
      setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
      setStatus(`Error: ${eventData.message}`);
    } else if (eventData.type === "cancelled") {
      setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
      setStatus(eventData.message || "Processing cancelled.");
    }
  }

  async function submitIehp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!iehpLoginFile || !claimFileHandle) {
      setStatus("Please provide both required files.");
      return;
    }

    const resumeJob = pendingIehpRestoreJob;

    try {
      if (resumeJob) {
        setPendingIehpRestoreJob(null);
        setIsProcessing(true);
        setStatus(`Resuming previous IEHP run from row ${resumeJob.currentCompleted + 1}...`);
        await resumeExistingIehpRun(resumeJob, claimFileHandle, iehpLoginFile);
        return;
      }

      resetRunState("Reading claim file...");
      await runIehpSession({
        claimFileHandle,
        loginFile: iehpLoginFile,
      });
    } catch (error) {
      if (resumeJob) {
        setPendingIehpRestoreJob(resumeJob);
      }
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
    let wasCancelled = false;
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
      } else if (eventData.type === "cancelled") {
        wasCancelled = true;
        setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
        setStatus(eventData.message || "Processing cancelled.");
      }
    };

    try {
      const jobId = await startScrapeJob(formData);
      subscribedJobId = jobId;
      setActiveJobId(jobId);
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
        wasCancelled
          ? "Aerial processing cancelled."
          : hasError
          ? `Aerial processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Aerial processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Aerial claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitAvaility(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!availityCredentialFile || !availityInputFile) {
      setStatus("Please provide both the Availity login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting Availity scraper...");

    const formData = new FormData();
    formData.append("portalId", "availity");
    formData.append("credentialExcel", availityCredentialFile);
    formData.append("inputExcel", availityInputFile);

    let hasError = false;
    let wasCancelled = false;
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
      } else if (eventData.type === "cancelled") {
        wasCancelled = true;
        setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
        setStatus(eventData.message || "Processing cancelled.");
      }
    };

    try {
      const jobId = await startScrapeJob(formData);
      subscribedJobId = jobId;
      setActiveJobId(jobId);
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Availity stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        wasCancelled
          ? "Availity processing cancelled."
          : hasError
          ? `Availity processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Availity processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Availity claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }



  async function submitBlueShield(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!blueShieldCredentialFile || !blueShieldInputFile) {
      setStatus("Please provide both the Blue Shield login Excel and input Excel files.");
      return;
    }

    const activeBlueShieldJob = pendingBlueShieldRestoreJob
      ?? await getCurrentScrapeJob().then((job) => (job?.portalId === "blue-shield" && (job.status === "running" || job.status === "waiting_resume") ? job : null)).catch(() => null);

    if (activeBlueShieldJob) {
      setIsCancellingJob(true);
      setStatus("Replacing previous Blue Shield run and starting a new one...");
      try {
        await cancelScrapeJobRequest(activeBlueShieldJob.jobId);
      } catch (error) {
        setIsCancellingJob(false);
        setStatus(`Failed to replace previous Blue Shield run: ${getErrorMessage(error)}`);
        return;
      } finally {
        setIsCancellingJob(false);
      }
    }

    setPendingBlueShieldRestoreJob(null);
    resetRunState(activeBlueShieldJob ? "Starting new Blue Shield scraper..." : "Starting Blue Shield scraper...");

    const formData = new FormData();
    formData.append("portalId", "blue-shield");
    formData.append("group", blueShieldGroup);
    formData.append("credentialExcel", blueShieldCredentialFile);
    formData.append("inputExcel", blueShieldInputFile);
    formData.append("checkpointId", blueShieldInputFile.name || "blue-shield");
    formData.append("resetCheckpoint", blueShieldResetCheckpoint ? "true" : "false");

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total });
      } else if (eventData.type === "input_request" && eventData.inputName) {
        setBlueShieldOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Enter verification code",
          message: eventData.message || "Enter the verification code sent by Blue Shield.",
        });
        setBlueShieldOtpValue("");
        setStatus(eventData.message || "Waiting for Blue Shield verification code.");
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
      } else if (eventData.type === "cancelled") {
        wasCancelled = true;
        setLogs((prev) => [...prev, eventData.message || "Processing cancelled."]);
        setStatus(eventData.message || "Processing cancelled.");
      }
    };

    try {
      const jobId = await startScrapeJob(formData);
      subscribedJobId = jobId;
      setBlueShieldJobId(jobId);
      setActiveJobId(jobId);
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
        wasCancelled
          ? "Blue Shield processing cancelled."
          : hasError
          ? `Blue Shield processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Blue Shield processing completed.",
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const currentJob = await getCurrentScrapeJob().catch(() => null);

      if (currentJob?.portalId === "blue-shield" && (currentJob.status === "running" || currentJob.status === "waiting_resume")) {
        setActiveJobId(currentJob.jobId);
        setPendingBlueShieldRestoreJob(currentJob);
        setSelectedPortalId("blue-shield");
        setStatus("A previous Blue Shield run is still active. Click Start processing to replace it, or Cancel Processing to stop it.");
      } else {
        setStatus(`Failed to process Blue Shield claims: ${errorMessage}`);
      }
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitBlueShieldOtp() {
    if (!blueShieldJobId || !blueShieldOtpRequest || !blueShieldOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: blueShieldJobId,
        inputName: blueShieldOtpRequest.inputName,
        value: blueShieldOtpValue.trim(),
      });
      setBlueShieldOtpRequest(null);
      setBlueShieldOtpValue("");
      setStatus("Blue Shield verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit Blue Shield OTP: ${getErrorMessage(error)}`);
    }
  }

  async function submitRegal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!regalClaimFile) {
      setStatus("Please provide the Regal claim Excel file.");
      return;
    }

    resetRunState("Starting Regal scraper...");

    const formData = new FormData();
    formData.append("portalId", "regal");
    if (pendingRegalRestoreJob) {
      formData.append("existingJobId", pendingRegalRestoreJob.jobId);
      formData.append("startIndex", String(pendingRegalRestoreJob.currentCompleted));
    }
    if (regalLoginFile) {
      formData.append("loginExcel", regalLoginFile);
      formData.append("loginFileName", regalLoginFile.name);
    }
    formData.append("claimExcel", regalClaimFile);
    formData.append("claimFileName", regalClaimFile.name);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    const diagnosticFiles: DownloadFile[] = [];
    const streamAbortController = new AbortController();

    try {
      const jobId = await startScrapeJob(formData);
      setPendingRegalRestoreJob(null);
      setRegalJobId(jobId);
      setActiveJobId(jobId);
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          await handleRegalJobEvent(eventData, jobId, (message) => {
            finalErrorMessage = message;
            hasError = true;
          }, diagnosticFiles);
          if (eventData.type === "cancelled") {
            wasCancelled = true;
          }
        },
        onStreamError(error) {
          console.error("Regal stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      downloadZip(`regal-diagnostics-${jobId}.zip`, diagnosticFiles);
      setStatus(
        wasCancelled
          ? "Regal processing cancelled."
          : hasError
          ? `Regal processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Regal processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Regal claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitRegalOtp() {
    if (!regalJobId || !regalOtpRequest || !regalOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: regalJobId,
        inputName: regalOtpRequest.inputName,
        value: regalOtpValue.trim(),
      });
      setRegalOtpRequest(null);
      setRegalOtpValue("");
      setStatus("Regal verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit Regal OTP: ${getErrorMessage(error)}`);
    }
  }

  async function submitRegalMfaMethod() {
    if (!regalJobId || !regalMfaRequest || !regalMfaValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: regalJobId,
        inputName: regalMfaRequest.inputName,
        value: regalMfaValue.trim(),
      });
      setRegalMfaRequest(null);
      setRegalMfaValue("");
      setStatus("Regal verification method submitted.");
    } catch (error) {
      setStatus(`Failed to submit Regal verification method: ${getErrorMessage(error)}`);
    }
  }

  function downloadLatestRegalOutput() {
    if (!latestRegalOutput) return;
    const completedSuffix = typeof latestRegalOutput.completed === "number" && typeof latestRegalOutput.total === "number"
      ? `-${latestRegalOutput.completed}-of-${latestRegalOutput.total}`
      : "";
    const filename = latestRegalOutput.filename === "regal_output_snapshot.xlsx"
      ? `regal_output_partial${completedSuffix}.xlsx`
      : latestRegalOutput.filename;
    downloadBase64File(filename, latestRegalOutput.base64, latestRegalOutput.mimeType);
  }

  if (authLoading || jobRestoreLoading) {
    return (
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.98)_0%,_rgba(240,246,255,0.98)_40%,_rgba(223,236,255,0.95)_100%)] px-4 text-slate-900">
        <div className="pointer-events-none absolute inset-0 opacity-60">
          <div className="absolute left-[10%] top-[18%] h-20 w-20 rounded-full bg-blue-100/70 blur-2xl" />
          <div className="absolute right-[12%] top-[12%] h-32 w-32 rounded-full bg-sky-100/80 blur-3xl" />
          <div className="absolute bottom-[16%] left-[18%] h-24 w-24 rounded-full bg-cyan-100/70 blur-3xl" />
          <div className="absolute right-[18%] bottom-[18%] h-px w-48 bg-sky-200" />
          <div className="absolute right-[13%] bottom-[18%] h-10 w-10 rounded-full border border-sky-200/80" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="relative w-full max-w-md rounded-[2rem] border border-sky-100 bg-white/88 p-8 shadow-[0_26px_70px_rgba(148,163,184,0.18)] backdrop-blur-xl"
        >
          <div className="flex items-center gap-4">
            <div className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-[1.25rem] border border-sky-100 bg-white shadow-[0_16px_32px_rgba(37,99,235,0.16)]">
              <Image
                src="/opus-logo-2.jfif"
                alt="OPUS logo"
                fill
                className="object-contain p-1.5"
              />
            </div>
            <div>
              <p className="text-xl font-semibold tracking-[-0.04em] text-slate-950">Claim Status Portal</p>
              <p className="text-sm text-slate-500">Preparing your healthcare workspace</p>
            </div>
          </div>

          <div className="mt-8 flex items-center gap-4">
            <div className="relative h-12 w-12">
              <div className="absolute inset-0 rounded-full border-4 border-sky-100" />
              <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-[#2563EB] border-r-[#3B82F6]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-sky-600">Loading</p>
              <p className="mt-1 text-base font-medium text-slate-800">Checking session, restoring portal state, and loading your dashboard.</p>
            </div>
          </div>

          <div className="mt-6 overflow-hidden rounded-full bg-sky-100/80">
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: "100%" }}
              transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
              className="h-2 w-1/2 rounded-full bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_55%,#38bdf8_100%)]"
            />
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {["Secure session", "Portal restore", "UI loading"].map((item) => (
              <div key={item} className="rounded-[1rem] border border-sky-100 bg-sky-50/70 px-3 py-3 text-center text-xs font-medium text-slate-600">
                {item}
              </div>
            ))}
          </div>
        </motion.div>
      </main>
    );
  }

  if (!authUser) {
    if (isProtectedRoute) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.98)_0%,_rgba(240,246,255,0.98)_44%,_rgba(227,238,255,0.95)_100%)] px-4 text-slate-900">
          <div className="rounded-2xl border border-sky-100 bg-white/90 px-5 py-4 text-sm font-medium shadow-[0_18px_40px_rgba(148,163,184,0.14)] backdrop-blur-xl">
            Redirecting to login...
          </div>
        </main>
      );
    }

    return (
      <main className="h-screen w-screen overflow-hidden bg-[#f5faff] text-slate-900">
        {forgotPasswordMode ? (
          <div className="relative flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#edf5ff_0%,#d9eaff_52%,#3b82f6_100%)] px-4">
            <div className="w-full max-w-md rounded-[28px] border border-white/80 bg-white/92 p-6 shadow-[0_32px_80px_rgba(15,23,42,0.14)]">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Reset Password</h1>
              <p className="mt-2 text-sm text-slate-500">Update your password to continue.</p>

              <form className="mt-6 space-y-4" onSubmit={onForgotPasswordSubmit}>
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" htmlFor="authUsername">
                    Username
                  </label>
                  <input
                    id="authUsername"
                    type="text"
                    autoComplete="username"
                    value={authUsername}
                    onChange={(event) => setAuthUsername(event.target.value)}
                    className="block w-full rounded-2xl border border-blue-100 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" htmlFor="authPassword">
                    New Password
                  </label>
                  <input
                    id="authPassword"
                    type="password"
                    autoComplete="new-password"
                    value={authPassword}
                    onChange={(event) => setAuthPassword(event.target.value)}
                    className="block w-full rounded-2xl border border-blue-100 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" htmlFor="authConfirmPassword">
                    Confirm Password
                  </label>
                  <input
                    id="authConfirmPassword"
                    type="password"
                    autoComplete="new-password"
                    value={authConfirmPassword}
                    onChange={(event) => setAuthConfirmPassword(event.target.value)}
                    className="block w-full rounded-2xl border border-blue-100 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                  />
                </div>

                {authError && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 shadow-sm">
                    {authError}
                  </div>
                )}

                {authStatus && (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700 shadow-sm">
                    {authStatus}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full rounded-2xl bg-[linear-gradient(135deg,#2563eb,#1d4ed8_55%,#0ea5e9)] px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_35px_rgba(37,99,235,0.32)] disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  {authSubmitting ? "Please wait..." : "Update Password"}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setForgotPasswordMode(false);
                    setAuthError("");
                    setAuthStatus("");
                    setAuthPassword("");
                    setAuthConfirmPassword("");
                  }}
                  className="w-full text-center text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  Back to login
                </button>
              </form>
            </div>
          </div>
        ) : (
          <>
            <div className="relative hidden h-full w-full md:block">
              <Image
                src={claimStatusHeroImage}
                alt="Claim Status Portal login background"
                fill
                priority
                className="pointer-events-none object-cover object-center select-none"
              />

              <form className="absolute inset-0" onSubmit={onAuthSubmit}>
                <label className="sr-only" htmlFor="authUsername">
                  Username
                </label>
                <input
                  id="authUsername"
                  type="text"
                  autoComplete="off"
                  value={authUsername}
                  onChange={(event) => setAuthUsername(event.target.value)}
                  className="absolute right-[9.65%] top-[43.45%] h-[4.7%] w-[34.3%] rounded-[14px] border-none bg-transparent px-[10.5%] text-[clamp(0.95rem,1vw,1.05rem)] font-medium text-slate-800 outline-none placeholder-transparent focus:bg-white/6"
                />

                <label className="sr-only" htmlFor="authPassword">
                  Password
                </label>
                <input
                  id="authPassword"
                  type="password"
                  autoComplete="off"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                  className="absolute right-[9.65%] top-[59.25%] h-[4.7%] w-[34.3%] rounded-[14px] border-none bg-transparent px-[10.5%] text-[clamp(0.95rem,1vw,1.05rem)] font-medium text-slate-800 outline-none placeholder-transparent focus:bg-white/6"
                />

                <label className="absolute right-[31.9%] top-[69.05%] flex items-center gap-2 text-[clamp(0.82rem,0.86vw,0.92rem)] text-transparent">
                  <input className="h-5 w-5 cursor-pointer opacity-0" type="checkbox" defaultChecked aria-label="Remember me" />
                  <span className="select-none">Remember me</span>
                </label>

                <button
                  type="button"
                  onClick={() => {
                    setForgotPasswordMode(true);
                    setAuthError("");
                    setAuthStatus("");
                    setAuthPassword("");
                    setAuthConfirmPassword("");
                  }}
                  className="absolute right-[9.55%] top-[68.7%] h-[3.8%] w-[13.4%] text-transparent"
                >
                  Forgot password?
                </button>

                {authError && (
                  <div className="absolute right-[9.65%] top-[74.7%] w-[34.3%] rounded-2xl border border-red-200 bg-red-50/95 px-4 py-3 text-sm font-medium text-red-700 shadow-sm">
                    {authError}
                  </div>
                )}

                {authStatus && (
                  <div className="absolute right-[9.65%] top-[74.7%] w-[34.3%] rounded-2xl border border-emerald-200 bg-emerald-50/95 px-4 py-3 text-sm font-medium text-emerald-700 shadow-sm">
                    {authStatus}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="absolute right-[9.65%] top-[74.15%] h-[6.7%] w-[34.3%] rounded-[18px] bg-transparent text-transparent disabled:cursor-not-allowed"
                >
                  {authSubmitting ? "Please wait..." : "Login"}
                </button>
              </form>
            </div>

            <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#edf5ff_0%,#d9eaff_52%,#3b82f6_100%)] px-4 md:hidden">
              <div className="w-full max-w-sm rounded-[28px] border border-white/80 bg-white/95 p-6 shadow-[0_32px_80px_rgba(15,23,42,0.14)]">
                <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Claim Status Portal</h1>
                <p className="mt-2 text-sm text-slate-500">Sign in to continue to your dashboard.</p>

                <form className="mt-6 space-y-4" onSubmit={onAuthSubmit}>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700" htmlFor="authUsernameMobile">
                      Username
                    </label>
                    <input
                      id="authUsernameMobile"
                      type="text"
                      autoComplete="off"
                      value={authUsername}
                      onChange={(event) => setAuthUsername(event.target.value)}
                      className="block h-12 w-full rounded-2xl border border-blue-100 bg-white px-4 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700" htmlFor="authPasswordMobile">
                      Password
                    </label>
                    <input
                      id="authPasswordMobile"
                      type="password"
                      autoComplete="off"
                      value={authPassword}
                      onChange={(event) => setAuthPassword(event.target.value)}
                      className="block h-12 w-full rounded-2xl border border-blue-100 bg-white px-4 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100/70"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4 text-sm">
                    <label className="flex items-center gap-2 text-slate-600">
                      <input className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" type="checkbox" defaultChecked />
                      <span>Remember me</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setForgotPasswordMode(true);
                        setAuthError("");
                        setAuthStatus("");
                        setAuthPassword("");
                        setAuthConfirmPassword("");
                      }}
                      className="font-medium text-blue-600 hover:text-blue-700"
                    >
                      Forgot password?
                    </button>
                  </div>

                  {authError && (
                    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 shadow-sm">
                      {authError}
                    </div>
                  )}

                  {authStatus && (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700 shadow-sm">
                      {authStatus}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={authSubmitting}
                    className="h-12 w-full rounded-2xl bg-[linear-gradient(135deg,#1692ff,#214edc_55%,#1e40d4)] text-base font-semibold text-white shadow-[0_16px_28px_rgba(29,78,216,0.28)] transition hover:brightness-[1.03] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {authSubmitting ? "Please wait..." : "Login"}
                  </button>
                </form>
              </div>
            </div>
          </>
        )}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.98)_0%,_rgba(240,246,255,0.98)_44%,_rgba(227,238,255,0.95)_100%)] text-slate-900">
      <nav className="relative z-30 border-b border-sky-100/80 bg-white/80 px-4 py-4 shadow-[0_10px_35px_rgba(148,163,184,0.12)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <button
            type="button"
            onClick={resetPortalSelection}
            className="flex items-center gap-3 text-left"
          >
            <span className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-[1.15rem] border border-sky-200 bg-white shadow-[0_18px_36px_rgba(37,99,235,0.2)]">
              <Image
                src="/opus-logo-2.jfif"
                alt="OPUS logo"
                fill
                className="object-contain p-1"
              />
            </span>
            <span>
              <span className="block text-lg font-semibold tracking-[-0.03em] text-slate-950">Claim Status Portal</span>
              <span className="block text-xs text-slate-500">Multi-portal workspace | Signed in as {authUser.email || authUser.username}</span>
            </span>
          </button>

          <div className="flex items-center gap-3">
            {effectivePortalId && !authUser.mustResetPassword && (
              <button
                type="button"
                disabled={isProcessing}
                onClick={resetPortalSelection}
                className="rounded-xl border border-sky-200 bg-white/90 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-blue-400 hover:bg-blue-50 disabled:text-slate-400"
              >
                Change portal
              </button>
            )}

          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="grid gap-6 xl:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="hidden rounded-[2rem] border border-sky-100 bg-white/82 p-5 shadow-[0_18px_60px_rgba(148,163,184,0.14)] backdrop-blur-xl xl:flex xl:min-h-[calc(100vh-10rem)] xl:flex-col">
            <div className="flex items-center gap-3 rounded-[1.4rem] bg-[linear-gradient(135deg,rgba(239,246,255,0.98)_0%,rgba(219,234,254,0.82)_100%)] p-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#1473ff_0%,#2563eb_60%,#183db9_100%)] text-white shadow-[0_16px_34px_rgba(37,99,235,0.22)]">
                <Stethoscope className="h-5 w-5" strokeWidth={2.1} />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-950">Claim Status Portal</p>
                <p className="text-xs text-slate-500">Healthcare Automation Platform</p>
              </div>
            </div>

            <nav className="mt-6 space-y-1.5">
              <button
                type="button"
                onClick={resetPortalSelection}
                className="flex w-full items-center gap-3 rounded-[1rem] bg-[linear-gradient(90deg,rgba(37,99,235,0.12)_0%,rgba(37,99,235,0.04)_100%)] px-3 py-2.5 text-left text-sm font-medium text-blue-700 transition"
              >
                <LayoutDashboard className="h-4 w-4" strokeWidth={2} />
                Dashboard
              </button>
              <button
                type="button"
                onClick={openResetPassword}
                className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900"
              >
                <ShieldEllipsis className="h-4 w-4" strokeWidth={2} />
                Reset Password
              </button>
              {authUser.role === "ADMIN" && (
                <button
                  type="button"
                  onClick={openManageUsers}
                  className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900"
                >
                  <Users className="h-4 w-4" strokeWidth={2} />
                  Manage Users
                </button>
              )}
              <button
                type="button"
                onClick={logout}
                disabled={isProcessing}
                className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400"
              >
                <LogOut className="h-4 w-4" strokeWidth={2} />
                Logout
              </button>
            </nav>

            <div className="mt-auto rounded-[1.4rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(245,250,255,0.98)_0%,rgba(233,243,255,0.92)_100%)] p-4 shadow-[0_14px_35px_rgba(148,163,184,0.12)]">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#e2fbf7_0%,#c4f1e8_100%)] text-emerald-600">
                <ShieldCheck className="h-5 w-5" strokeWidth={2.1} />
              </div>
              <p className="mt-4 text-sm font-semibold text-slate-900">HIPAA Compliant</p>
              <p className="mt-2 text-xs leading-5 text-slate-600">
                Your data is protected with enterprise-grade security and encrypted session controls.
              </p>
              <p className="mt-8 text-[0.7rem] text-slate-400">Copyright 2026 Claim Status Portal</p>
            </div>
          </aside>

          <div className="min-w-0">
        {activeView === "reset-password" ? (
          <div className="mx-auto w-full max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold">Reset Password</h1>
                {authUser.mustResetPassword && (
                  <p className="mt-1 text-sm text-slate-600">You need to reset your password before accessing the portal.</p>
                )}
              </div>
              {!authUser.mustResetPassword && (
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
              )}
            </div>

            <form className="mt-5 space-y-4" onSubmit={resetPasswordFromSettings}>
              <div>
                <label className="mb-2 block text-sm font-medium" htmlFor="settingsPassword">
                  Password
                </label>
                <input
                  id="settingsPassword"
                  type="password"
                  autoComplete="new-password"
                  value={settingsPassword}
                  onChange={(event) => setSettingsPassword(event.target.value)}
                  className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium" htmlFor="settingsConfirmPassword">
                  Confirm Password
                </label>
                <input
                  id="settingsConfirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={settingsConfirmPassword}
                  onChange={(event) => setSettingsConfirmPassword(event.target.value)}
                  className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                />
              </div>

              {settingsPasswordError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
                  {settingsPasswordError}
                </div>
              )}

              {settingsPasswordStatus && (
                <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm font-medium text-green-700">
                  {settingsPasswordStatus}
                </div>
              )}

              <button
                type="submit"
                disabled={settingsPasswordSubmitting}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {settingsPasswordSubmitting ? "Please wait..." : "Update Password"}
              </button>
            </form>
          </div>
        ) : activeView === "manage-users" && authUser.role === "ADMIN" ? (
          <div className="mx-auto w-full max-w-5xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h1 className="text-xl font-semibold">Manage Users</h1>
              <button
                type="button"
                onClick={() => {
                  setActiveView("portal-selection");
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
          <div className="mx-auto w-full max-w-5xl rounded-[2rem] border border-sky-100 bg-white/86 p-6 shadow-[0_24px_80px_rgba(148,163,184,0.16)] backdrop-blur-xl md:p-8">
            {!selectedPortal ? (
            <>
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Multi-Portal Dashboard</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-3 rounded-[1rem] border border-sky-100 bg-white/95 px-3 py-2 shadow-[0_10px_24px_rgba(148,163,184,0.08)]">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[linear-gradient(135deg,#dbeafe_0%,#bfdbfe_100%)] text-xs font-semibold text-blue-700">
                      {userInitials || "AF"}
                    </div>
                    <div className="hidden sm:block">
                      <p className="text-sm font-semibold text-slate-900">{userDisplayName || "Afrin"}</p>
                      <p className="text-[0.7rem] text-slate-500">{authUser.role === "ADMIN" ? "Administrator" : "User"}</p>
                    </div>
                  </div>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                className="relative overflow-hidden rounded-[1.7rem] border border-sky-100 bg-[linear-gradient(135deg,rgba(239,246,255,0.96)_0%,rgba(221,235,255,0.82)_50%,rgba(255,255,255,0.94)_100%)] px-6 py-7 shadow-[0_18px_44px_rgba(148,163,184,0.12)]"
              >
                <div className="max-w-[25rem]">
                  <h1 className="text-[2rem] font-semibold tracking-[-0.05em] text-slate-950">
                    Welcome Back, <span className="text-[#2563EB]">{userDisplayName || "Afrin"}</span> 👋
                  </h1>
                  <p className="mt-3 max-w-md text-sm leading-6 text-slate-600">
                    Select a healthcare payer portal to automate claim status verification.
                  </p>
                </div>
                <div className="pointer-events-none absolute right-0 top-0 hidden h-full w-[40%] overflow-hidden rounded-l-[1.6rem] border-l border-sky-100/70 bg-white/35 shadow-[0_18px_42px_rgba(59,130,246,0.12)] lg:block">
                  <Image
                    src={dashboardWelcomeImage}
                    alt="Medical clipboard illustration"
                    fill
                    className="object-cover object-center opacity-100 scale-[1.08]"
                  />
                  <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(244,248,255,0.12)_0%,rgba(244,248,255,0)_22%,rgba(244,248,255,0)_100%)]" />
                </div>
              </motion.div>

              <div className="mt-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <label className="flex h-12 w-full items-center gap-3 rounded-[1rem] border border-sky-100 bg-white/95 px-4 shadow-[0_10px_28px_rgba(148,163,184,0.1)] lg:max-w-[24rem]">
                    <Search className="h-4 w-4 text-slate-400" strokeWidth={2.2} />
                    <input
                      type="text"
                      value={portalSearch}
                      onChange={(event) => setPortalSearch(event.target.value)}
                      placeholder="Search portals..."
                      className="w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
                    />
                  </label>
                  <div className="flex items-center gap-3 text-sm text-slate-500">
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setFilterMenuOpen((open) => !open)}
                        className="inline-flex h-10 items-center gap-2 rounded-[0.95rem] border border-sky-100 bg-white/95 px-4 text-sm font-medium text-slate-700 shadow-[0_10px_24px_rgba(148,163,184,0.08)]"
                      >
                        <SlidersHorizontal className="h-4 w-4" strokeWidth={2.1} />
                        Filters
                      </button>
                      {filterMenuOpen && (
                        <div className="absolute right-0 top-full z-20 mt-2 w-52 rounded-[1rem] border border-sky-100 bg-white/98 p-2 shadow-[0_18px_44px_rgba(15,23,42,0.12)] backdrop-blur-xl">
                          <button
                            type="button"
                            onClick={() => {
                              setPortalFilter("all");
                              setFilterMenuOpen(false);
                            }}
                            className={`block w-full rounded-[0.8rem] px-3 py-2 text-left text-sm ${
                              portalFilter === "all" ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-sky-50"
                            }`}
                          >
                            All portals
                          </button>
                          {availablePortals.map((portal) => (
                            <button
                              key={`filter-${portal.id}`}
                              type="button"
                              onClick={() => {
                                setPortalFilter(portal.id as PortalId);
                                setFilterMenuOpen(false);
                              }}
                              className={`block w-full rounded-[0.8rem] px-3 py-2 text-left text-sm ${
                                portalFilter === portal.id ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-sky-50"
                              }`}
                            >
                              {portal.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setPortalSort((current) => (current === "name-asc" ? "name-desc" : "name-asc"))
                      }
                      className="inline-flex h-10 items-center gap-2 rounded-[0.95rem] border border-sky-100 bg-white/95 px-4 text-sm font-medium text-slate-700 shadow-[0_10px_24px_rgba(148,163,184,0.08)]"
                    >
                      Sort by
                      <span className="text-slate-500">{portalSort === "name-asc" ? "A-Z" : "Z-A"}</span>
                    </button>
                  </div>
                </div>

                <div className="mb-4 flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">Available Portals</h2>
                    <p className="mt-1 text-xs text-slate-500">Launch claim status automation workspaces</p>
                  </div>
                  <div className="text-xs text-slate-400">Showing {filteredPortals.length} of {availablePortals.length}</div>
                </div>

                {filteredPortals.length === 0 ? (
                  <div className="rounded-[1.4rem] border border-dashed border-sky-200 bg-white/80 px-6 py-10 text-center text-sm text-slate-500">
                    No portals matched your search. Try another keyword.
                  </div>
                ) : (
                  <div className={portalLayout === "grid" ? "grid gap-4 md:grid-cols-2 xl:grid-cols-4" : "space-y-4"}>
                    {filteredPortals.map((portal) => {
                      const meta = PORTAL_UI_META[portal.id as PortalId];

                      return (
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
                          className={`group rounded-[1.35rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.99)_0%,rgba(246,250,255,0.97)_100%)] p-4 text-left shadow-[0_16px_36px_rgba(148,163,184,0.12)] transition hover:-translate-y-0.5 hover:border-blue-400 hover:shadow-[0_22px_44px_rgba(59,130,246,0.14)] ${
                            portalLayout === "list" ? "flex items-start gap-4" : ""
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <span
                              className={`flex items-center justify-center overflow-hidden text-xs font-semibold shadow-inner ${
                                meta.logoSrc ? (meta.cardLogoFrameClassName ?? "h-10 w-[4.4rem] rounded-[1rem] px-2") : "h-10 w-10 rounded-2xl"
                              } ${meta.logoClassName}`}
                            >
                              {meta.logoSrc ? (
                                <Image
                                  src={meta.logoSrc}
                                  alt={`${portal.name} logo`}
                                  width={meta.cardLogoSize?.width ?? 56}
                                  height={meta.cardLogoSize?.height ?? 20}
                                  className={meta.cardLogoImageClassName ?? "h-5 w-full object-contain"}
                                />
                              ) : (
                                meta.shortCode
                              )}
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[0.65rem] font-semibold text-emerald-600">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Ready
                            </span>
                          </div>
                          <span className={`block ${portalLayout === "list" ? "flex-1" : ""}`}>
                            <span className={`${portalLayout === "grid" ? "mt-4" : ""} block text-base font-semibold tracking-[-0.03em] text-slate-950`}>{portal.name}</span>
                            <span className="mt-2 block text-[0.72rem] leading-5 text-slate-600">{portal.description}</span>
                            <span className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[0.9rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-3 py-2.5 text-sm font-medium text-white shadow-[0_14px_26px_rgba(37,99,235,0.22)]">
                              Open Portal
                              <span aria-hidden="true">&rarr;</span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
            ) : (
            <>
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45 }}
                className="relative overflow-hidden rounded-[1.8rem] border border-sky-100 bg-[linear-gradient(135deg,rgba(239,246,255,0.96)_0%,rgba(221,235,255,0.84)_55%,rgba(255,255,255,0.96)_100%)] p-6 shadow-[0_20px_46px_rgba(148,163,184,0.14)]"
              >
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_25rem] lg:items-center">
                  <div className="max-w-2xl">
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={`flex items-center justify-center overflow-hidden text-sm font-semibold shadow-inner ${
                          selectedPortalUiMeta?.logoSrc
                            ? (selectedPortalUiMeta.heroLogoFrameClassName ?? "h-14 w-[6.25rem] rounded-[1.15rem] px-3")
                            : "h-14 w-14 rounded-[1.25rem]"
                        } ${selectedPortalUiMeta?.logoClassName ?? "bg-blue-50 text-blue-700"}`}
                      >
                        {selectedPortalUiMeta?.logoSrc ? (
                          <Image
                            src={selectedPortalUiMeta.logoSrc}
                            alt={`${selectedPortal.name} logo`}
                            width={selectedPortalUiMeta.heroLogoSize?.width ?? 84}
                            height={selectedPortalUiMeta.heroLogoSize?.height ?? 28}
                            className={selectedPortalUiMeta.heroLogoImageClassName ?? "h-7 w-full object-contain"}
                          />
                        ) : (
                          selectedPortalUiMeta?.shortCode ?? "PRT"
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-600">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Ready
                      </span>
                    </div>
                    <h1 className="mt-5 text-[2rem] font-semibold tracking-[-0.05em] text-slate-950">{selectedPortal.name}</h1>
                    <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
                      {portalWorkflowMeta?.heroDescription ?? selectedPortal.description}
                    </p>
                  </div>

                  <div className="relative hidden h-[17rem] overflow-hidden rounded-[1.6rem] border border-sky-100/80 bg-white/55 shadow-[0_18px_40px_rgba(59,130,246,0.12)] lg:block">
                    <Image
                      src={dashboardWelcomeImage}
                      alt="Healthcare workflow illustration"
                      fill
                      className="object-cover object-center opacity-100"
                    />
                    <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(244,248,255,0.02)_0%,rgba(244,248,255,0)_28%,rgba(244,248,255,0.12)_100%)]" />
                  </div>
                </div>
              </motion.div>

              <div className="mt-5 rounded-[1.5rem] border border-sky-100 bg-white/88 p-5 shadow-[0_16px_34px_rgba(148,163,184,0.1)]">
                <div className="flex flex-wrap items-center gap-3 md:flex-nowrap">
                  {portalWorkflowSteps.map((step, index) => {
                    const isActive = index === portalWorkflowStepIndex;
                    const isComplete = index < portalWorkflowStepIndex;

                    return (
                      <div key={step} className="flex min-w-0 flex-1 items-center gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                          isComplete
                            ? "bg-emerald-100 text-emerald-700"
                            : isActive
                              ? "bg-[linear-gradient(135deg,#2563eb_0%,#3b82f6_100%)] text-white shadow-[0_12px_24px_rgba(37,99,235,0.24)]"
                              : "bg-sky-50 text-slate-500"
                        }`}>
                          {index + 1}
                        </div>
                        <div className="min-w-0">
                          <p className={`truncate text-sm font-medium ${isActive || isComplete ? "text-slate-900" : "text-slate-500"}`}>{step}</p>
                        </div>
                        {index < portalWorkflowSteps.length - 1 ? (
                          <div className={`hidden h-px flex-1 md:block ${isComplete ? "bg-emerald-300" : "bg-sky-100"}`} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-5">
                <div className="rounded-[1.7rem] border border-sky-100 bg-white/92 p-5 shadow-[0_16px_38px_rgba(148,163,184,0.12)]">
                  <div className="mb-5">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Portal Workflow</p>
                    <h2 className="mt-3 text-xl font-semibold tracking-[-0.04em] text-slate-950">
                      {effectivePortalId === "blue-shield" && hasCompletedRun ? "Processing Completed" : "Upload and Validate Files"}
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                      {effectivePortalId === "blue-shield" && hasCompletedRun
                        ? "This Blue Shield run has finished. You can review the status and logs below, or reset the workflow to start another run."
                        : "Use the guided upload workflow below to validate workbooks, secure the transfer, and launch automation."}
                    </p>
                  </div>

                  {effectivePortalId === "blue-shield" && hasCompletedRun ? (
                    <div className="rounded-[1.2rem] border border-emerald-100 bg-emerald-50/70 p-5">
                      <p className="text-sm font-semibold text-emerald-800">Blue Shield processing is complete.</p>
                      <p className="mt-2 text-sm text-emerald-700">{status}</p>
                      <button
                        type="button"
                        onClick={resetBlueShieldWorkflow}
                        className="mt-4 inline-flex items-center justify-center rounded-[1rem] border border-emerald-200 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-50"
                      >
                        Start Another Run
                      </button>
                    </div>
                  ) : effectivePortalId === "iehp" ? (
                    <IehpInputForm
                      canSubmit={canSubmitIehp}
                      claimFileName={claimFileName}
                      isProcessing={isProcessing}
                      isResumePending={Boolean(pendingIehpRestoreJob)}
                      loginFileName={iehpLoginFile?.name ?? ""}
                      onLoginFileChange={handleLoginFileChange}
                      onSelectClaimFile={selectClaimFile}
                      onSubmit={submitIehp}
                    />
                  ) : effectivePortalId === "aerial" ? (
                    <AerialInputForm
                      canSubmit={canSubmitAerial}
                      credentialFileName={aerialCredentialFile?.name ?? ""}
                      inputFileName={aerialInputFile?.name ?? ""}
                      isProcessing={isProcessing}
                      onCredentialFileChange={setAerialCredentialFile}
                      onInputFileChange={setAerialInputFile}
                      onSubmit={submitAerial}
                    />
                  ) : effectivePortalId === "regal" ? (
                    <RegalInputForm
                      canSubmit={canSubmitRegal}
                      claimFileName={regalClaimFile?.name ?? ""}
                      isProcessing={isProcessing}
                      loginFileName={regalLoginFile?.name ?? ""}
                      onClaimFileChange={setRegalClaimFile}
                      onLoginFileChange={setRegalLoginFile}
                      onSubmit={submitRegal}
                    />
                  ) : effectivePortalId === "availity" ? (
                    <AvailityInputForm
                      canSubmit={canSubmitAvaility}
                      credentialFileName={availityCredentialFile?.name ?? ""}
                      inputFileName={availityInputFile?.name ?? ""}
                      isProcessing={isProcessing}
                      onCredentialFileChange={setAvailityCredentialFile}
                      onInputFileChange={setAvailityInputFile}
                      onSubmit={submitAvaility}
                    />
                  ) : (
                    <BlueShieldInputForm
                      canSubmit={canSubmitBlueShield}
                      credentialFileName={blueShieldCredentialFile?.name ?? ""}
                      group={blueShieldGroup}
                      inputFileName={blueShieldInputFile?.name ?? ""}
                      isProcessing={isProcessing}
                      resetCheckpoint={blueShieldResetCheckpoint}
                      onCredentialFileChange={setBlueShieldCredentialFile}
                      onGroupChange={setBlueShieldGroup}
                      onInputFileChange={setBlueShieldInputFile}
                      onResetCheckpointChange={setBlueShieldResetCheckpoint}
                      onSubmit={submitBlueShield}
                    />
                  )}

                  {(activeJobId || pendingBlueShieldRestoreJob || pendingIehpRestoreJob) && (
                    <div className="mt-4 flex flex-col gap-3 rounded-[1.2rem] border border-sky-100 bg-sky-50/70 p-4 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => void cancelActiveJob()}
                        disabled={isCancellingJob}
                        className="inline-flex flex-1 items-center justify-center rounded-[1rem] border border-red-200 bg-white px-4 py-3 text-sm font-semibold text-red-700 shadow-sm transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      >
                        {isCancellingJob ? "Cancelling..." : "Cancel Processing"}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-5 rounded-[1.7rem] border border-sky-100 bg-white/92 p-5 shadow-[0_16px_38px_rgba(148,163,184,0.12)]">
                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">Workflow Status</p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-[1rem] border border-sky-100 bg-sky-50/70 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Login File</p>
                    <p className="mt-1 text-sm font-medium text-slate-800">{portalFileState.loginFileLabel || "Waiting for upload"}</p>
                  </div>
                  <div className="rounded-[1rem] border border-sky-100 bg-sky-50/70 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Claim File</p>
                    <p className="mt-1 text-sm font-medium text-slate-800">{portalFileState.claimFileLabel || "Waiting for upload"}</p>
                  </div>
                  <div className="rounded-[1rem] border border-sky-100 bg-sky-50/70 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Processing State</p>
                    <p className="mt-1 text-sm font-medium text-slate-800">{status || (isProcessing ? "Processing is currently running." : "Waiting for file validation.")}</p>
                  </div>
                </div>
              </div>

              {effectivePortalId === "iehp" ? (
                <div className="mt-5">
                  <IehpResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
              ) : effectivePortalId === "aerial" ? (
                <div className="mt-5">
                  <AerialResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
              ) : effectivePortalId === "regal" ? (
                <div className="mt-5">
                  <RegalResultView
                    canDownloadOutput={Boolean(latestRegalOutput)}
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    mfaRequest={regalMfaRequest}
                    mfaValue={regalMfaValue}
                    onMfaChange={setRegalMfaValue}
                    onMfaSubmit={submitRegalMfaMethod}
                    onOutputDownload={downloadLatestRegalOutput}
                    onOtpChange={setRegalOtpValue}
                    onOtpSubmit={submitRegalOtp}
                    otpRequest={regalOtpRequest}
                    otpValue={regalOtpValue}
                    progress={progress}
                    outputCompleted={latestRegalOutput?.completed}
                    outputTotal={latestRegalOutput?.total}
                    status={status}
                  />
                </div>
              ) : effectivePortalId === "availity" ? (
                <div className="mt-5">
                  <AvailityResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
              ) : (
                <div className="mt-5">
                  <BlueShieldResultView
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    onOtpChange={setBlueShieldOtpValue}
                    onOtpSubmit={submitBlueShieldOtp}
                    otpRequest={blueShieldOtpRequest}
                    otpValue={blueShieldOtpValue}
                    progress={progress}
                    status={status}
                  />
                </div>
              )}
            </>
            )}
          </div>
        )}
          </div>
        </div>
      </div>
    </main>
  );
}
