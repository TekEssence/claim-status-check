"use client";

import { motion } from "framer-motion";
import { FormEvent, useEffect, useMemo, useState } from "react";
import Image, { type StaticImageData } from "next/image";
import { usePathname, useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import {
  Activity,
  ArrowLeft,
  CheckCheck,
  Download,
  FileSpreadsheet,
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
import claimStatusHeroImage from "../../Assets/ChatGPT Image Jun 30, 2026, 12_47_57 PM.png";
import dashboardWelcomeImage from "../../Assets/ChatGPT Image Jul 1, 2026, 10_55_01 AM.png";
import blueShieldCaliforniaLogo from "../../Assets/customerlogo-blue-shield-california-clr.svg";
import cignaLogo from "../../Assets/cigna-healthcare-logo.svg";
import iehpLogo from "../../Assets/channels4_profile.jpg";
import kaiserLogo from "../../Assets/kaiser-permanente-logo.svg";
import myFamilyLogo from "../../Assets/my-family-medical-group-logo.svg";
import optumLogo from "../../Assets/optum-logo.svg";
import physiciansLogo from "../../Assets/physicians-health-network-logo.svg";
import regalLogo from "../../Assets/channels4_profile (1).jpg";
import availityLogo from "../../Assets/availity-logo.jpg";
import waystarLogo from "../../Assets/waystar-logo-vector.png";
import { applyClaimRowUpdateToWorksheet, postProcessWorksheet } from "./portals/iehp/workbook";
import { applyUhcRowUpdateToWorksheet, parseUhcClaimRows, postProcessUhcWorksheet } from "./portals/uhc/workbook";
import {
  cancelScrapeJob as cancelScrapeJobRequest,
  forceStopScrapeJob,
  getActiveScrapeJobErrorId,
  getCurrentScrapeJob,
  getScrapeJobDetails,
  getScrapeJobDownload,
  isAwsWorkflowMode,
  listScrapeJobs,
  startScrapeJob,
  subscribeToScrapeJobEvents,
  submitScrapeJobInput,
  ScrapeJobAuthError,
  type CurrentScrapeJob,
  type ScrapeJobSummary,
} from "../../api/scrape-jobs-api";
import { clearCognitoAccessToken, getCognitoAccessToken, getCognitoUserProfile, isCognitoMode, redirectToCognitoLogin, redirectToCognitoLogout, storeCognitoTokenFromHash } from "../../api/cognito-auth";
import { clearStoredRunContext, loadClaimFileHandle, loadIehpLoginFile, saveClaimFileHandle, saveIehpLoginFile } from "../../lib/run-context-store";
import type { FileSystemFileHandle, WindowWithFilePicker } from "../../types/file-system-access";
import type { ClaimRow, ErrorScreenshot, JobProgressValue, ScrapeJobEvent } from "../../types/job";
import { IehpInputForm } from "./portals/iehp/IehpInputForm";
import { IehpResultView } from "./portals/iehp/IehpResultView";
import { AerialInputForm, type AerialSubportal } from "./portals/aerial/AerialInputForm";
import { getAerialSubportal } from "./portals/aerial/subportals/registry";
import { AerialResultView } from "./portals/aerial/AerialResultView";
import { RegalInputForm } from "./portals/regal/RegalInputForm";
import { RegalResultView } from "./portals/regal/RegalResultView";
import { BlueShieldInputForm } from "./portals/blue-shield/BlueShieldInputForm";
import { BlueShieldResultView } from "./portals/blue-shield/BlueShieldResultView";
import { AvailityInputForm } from "./portals/availity/AvailityInputForm";
import { AvailityResultView } from "./portals/availity/AvailityResultView";
import { UhcInputForm } from "./portals/uhc/UhcInputForm";
import { UhcResultView, type UhcProviderPrompt } from "./portals/uhc/UhcResultView";
import { AstronaInputForm } from "./portals/astrona/AstronaInputForm";
import { AstronaResultView } from "./portals/astrona/AstronaResultView";
import { AllCareInputForm } from "./portals/all-care/AllCareInputForm";
import { AllCareResultView } from "./portals/all-care/AllCareResultView";
import { CignaInputForm } from "./portals/cigna/CignaInputForm";
import { CignaResultView } from "./portals/cigna/CignaResultView";
import { KaiserInputForm } from "./portals/kaiser/KaiserInputForm";
import { KaiserResultView } from "./portals/kaiser/KaiserResultView";
import { MyFamilyInputForm } from "./portals/my_family/MyFamilyInputForm";
import { MyFamilyResultView } from "./portals/my_family/MyFamilyResultView";
import { OptumProInputForm } from "./portals/optum-pro/OptumProInputForm";
import { OptumProResultView } from "./portals/optum-pro/OptumProResultView";
import { PhysiciansInputForm } from "./portals/physicians/PhysiciansInputForm";
import { PhysiciansResultView } from "./portals/physicians/PhysiciansResultView";
import { WaystarInputForm } from "./portals/waystar/WaystarInputForm";
import { WaystarResultView } from "./portals/waystar/WaystarResultView";
import {
  aerialFrontendPortalConfig,
  allCareFrontendPortalConfig,
  astronaFrontendPortalConfig,
  availityFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  claimStatusPortalRegistry,
  cignaFrontendPortalConfig,
  iehpFrontendPortalConfig,
  kaiserFrontendPortalConfig,
  myFamilyFrontendPortalConfig,
  optumProFrontendPortalConfig,
  physiciansFrontendPortalConfig,
  regalFrontendPortalConfig,
  uhcFrontendPortalConfig,
  waystarFrontendPortalConfig,
} from "./registry";

type AuthUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "DEVELOPER" | "USER";
  mustResetPassword: boolean;
};

type ManagedUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "DEVELOPER" | "USER";
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

type UhcWorkbookBundle = {
  claimRows: ReturnType<typeof parseUhcClaimRows>;
  totalRows: number;
  excelWb: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
};

export type PortalId =
  | "iehp"
  | "aerial"
  | "all-care"
  | "astrona"
  | "regal"
  | "blue-shield"
  | "availity"
  | "cigna"
  | "kaiser"
  | "medpoint"
  | "my-family"
  | "optum-pro"
  | "physicians"
  | "uhc"
  | "waystar";
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
const AUTH_USER_STORAGE_KEY = "claim-status-auth-user";
const DOWNLOADED_ARTIFACTS_PREFIX = "iehp-downloaded-artifacts:";
const PORTAL_ROUTE_MAP: Record<PortalId, string> = {
  iehp: "/iehp",
  aerial: "/aerial",
  "all-care": "/all-care",
  astrona: "/astrona",
  regal: "/regal",
  "blue-shield": "/blue-shield",
  availity: "/availity",
  cigna: "/cigna",
  kaiser: "/kaiser",
  medpoint: "/medpoint",
  "my-family": "/my-family",
  "optum-pro": "/optum-pro",
  physicians: "/physicians",
  uhc: "/uhc",
  waystar: "/claim-status/waystar",
};

function isPortalId(value: string): value is PortalId {
  return value === "iehp" || value === "aerial" || value === "all-care" || value === "astrona" || value === "regal" || value === "blue-shield" || value === "availity" || value === "cigna" || value === "kaiser" || value === "medpoint" || value === "my-family" || value === "optum-pro" || value === "physicians" || value === "uhc" || value === "waystar";
}

function isTerminalWorkflowStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isLiveWorkflowStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting_otp" || status === "waiting_resume" || status === "cancelling";
}

const WORKFLOW_LABELS: Record<string, string> = {
  "claim-status": "Claim Status",
  "eligibility-verification": "Eligibility",
  "payment-eob-download": "Payment EOB",
  "payment-posting": "Payment Posting",
};

function formatShortJobId(jobId: string): string {
  return jobId ? jobId.slice(0, 8) : "";
}

function formatRunTimestamp(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatWorkflowLabel(workflowId: string | undefined): string {
  if (!workflowId) return "Claim Status";
  return WORKFLOW_LABELS[workflowId] ?? workflowId;
}

function formatUploadedJobFiles(job: ScrapeJobSummary): string {
  const files = [job.loginFileName, job.claimFileName]
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  return files.length > 0 ? files.join(", ") : "Uploaded files";
}

function isExcelOutputArtifact(artifact: CurrentScrapeJob["artifacts"][number]): boolean {
  const filename = artifact.filename.toLowerCase();
  const mimeType = artifact.mimeType.toLowerCase();
  const isOutputArtifact = artifact.artifactType === "output_snapshot" || artifact.artifactType === "file_download";
  if (!isOutputArtifact) return false;
  return (
    filename.endsWith(".xlsx") ||
    filename.endsWith(".xls") ||
    filename.endsWith(".csv") ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType.includes("csv")
  );
}

function hasExcelOutput(job: ScrapeJobSummary): boolean {
  return (job.artifacts ?? []).some(isExcelOutputArtifact);
}

function formatUserRole(role: AuthUser["role"]): string {
  if (role === "ADMIN") return "Administrator";
  if (role === "DEVELOPER") return "Developer";
  return "User";
}

function hasFullWorkflowAccess(user: AuthUser | null): boolean {
  return user?.role === "ADMIN" || user?.role === "DEVELOPER";
}

function canRestoreCurrentJob(job: CurrentScrapeJob): job is CurrentScrapeJob & { portalId: PortalId } {
  if (!isPortalId(job.portalId)) return false;
  if (job.status === "running") return true;
  return job.portalId === "iehp" && job.status === "waiting_resume";
}

function persistCachedAuthUser(user: AuthUser | null) {
  if (typeof window === "undefined") return;
  try {
    if (user) {
      window.sessionStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user));
    } else {
      window.sessionStorage.removeItem(AUTH_USER_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
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
  "all-care": {
    shortCode: "AC",
    logoClassName: "bg-[linear-gradient(180deg,#e0f2fe_0%,#bae6fd_100%)] text-sky-700",
  },
  astrona: {
    shortCode: "AS",
    logoClassName: "bg-[linear-gradient(180deg,#dff7f3_0%,#bdece4_100%)] text-teal-700",
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
  cigna: {
    shortCode: "CG",
    logoClassName: "bg-white text-blue-700",
    logoSrc: cignaLogo,
    cardLogoFrameClassName: "h-10 w-[5.6rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-7 w-full object-contain",
    cardLogoSize: {
      width: 82,
      height: 36,
    },
    heroLogoFrameClassName: "h-14 w-[8rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-10 w-full object-contain",
    heroLogoSize: {
      width: 116,
      height: 52,
    },
  },
  kaiser: {
    shortCode: "KP",
    logoClassName: "bg-white text-cyan-700",
    logoSrc: kaiserLogo,
    cardLogoFrameClassName: "h-10 w-[8.6rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-6 w-full object-contain",
    cardLogoSize: {
      width: 124,
      height: 24,
    },
    heroLogoFrameClassName: "h-14 w-[12rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-8 w-full object-contain",
    heroLogoSize: {
      width: 176,
      height: 32,
    },
  },
  medpoint: {
    shortCode: "MP",
    logoClassName: "bg-[linear-gradient(180deg,#eef2ff_0%,#dbeafe_100%)] text-indigo-700",
  },
  "my-family": {
    shortCode: "MF",
    logoClassName: "bg-[#111827] text-cyan-700",
    logoSrc: myFamilyLogo,
    cardLogoFrameClassName: "h-10 w-[8.8rem] rounded-[1rem] px-1.5",
    cardLogoImageClassName: "h-full w-full object-contain",
    cardLogoSize: {
      width: 132,
      height: 40,
    },
    heroLogoFrameClassName: "h-14 w-[12.5rem] rounded-[1.15rem] px-2",
    heroLogoImageClassName: "h-full w-full object-contain",
    heroLogoSize: {
      width: 184,
      height: 55,
    },
  },
  "optum-pro": {
    shortCode: "OP",
    logoClassName: "bg-white text-orange-600",
    logoSrc: optumLogo,
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
  physicians: {
    shortCode: "PHN",
    logoClassName: "bg-white text-red-700",
    logoSrc: physiciansLogo,
    cardLogoFrameClassName: "h-10 w-[9.4rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-7 w-full object-contain",
    cardLogoSize: {
      width: 136,
      height: 37,
    },
    heroLogoFrameClassName: "h-14 w-[13rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-10 w-full object-contain",
    heroLogoSize: {
      width: 190,
      height: 52,
    },
  },
  uhc: {
    shortCode: "UHC",
    logoClassName: "bg-white text-blue-800",
    logoSrc: "/uhc-logo.svg",
    cardLogoFrameClassName: "h-10 w-[6.6rem] rounded-[1rem] px-2",
    cardLogoImageClassName: "h-7 w-full object-contain",
    cardLogoSize: {
      width: 94,
      height: 28,
    },
    heroLogoFrameClassName: "h-14 w-[8.5rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-9 w-full object-contain",
    heroLogoSize: {
      width: 120,
      height: 36,
    },
  },
  waystar: {
    shortCode: "WS",
    logoClassName: "bg-white text-slate-700",
    logoSrc: waystarLogo,
    cardLogoFrameClassName: "h-10 w-[6.1rem] rounded-[1rem] px-2.5",
    cardLogoImageClassName: "h-full w-full scale-[1.55] object-contain",
    cardLogoSize: {
      width: 92,
      height: 28,
    },
    heroLogoFrameClassName: "h-14 w-[8.2rem] rounded-[1.15rem] px-3",
    heroLogoImageClassName: "h-full w-full scale-[1.55] object-contain",
    heroLogoSize: {
      width: 120,
      height: 38,
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
  "all-care": {
    heroDescription: "Upload All Care Group/Payer credentials and claim rows for DOS- and CPT-specific status checks.",
    processingDescription: "All Care routes each row to the matching Group and Responsible Payer login, then reads the matching service line.",
  },
  astrona: {
    heroDescription: "Upload Astrona Group/Payer credentials and member claim rows to begin automated claim-status verification.",
    processingDescription: "Astrona isolates each Group and Payer login, selects the matching IPA, and extracts every available claim and service CPT.",
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
    heroDescription: "Upload your Availity login workbook and claim workbook to process Aetna, Anthem-CA, Blue Cross Blue Shield, Wellpoint, Wellcare, Humana, Central Health Medicare Plan, Health Net, Molina, Providence Health Plan, Scan Health, TRIWEST-TRICARE, and TRIWEST-VA CCN claim status checks.",
    processingDescription: "Availity requests stream live status over SSE and automatically download the completed output workbook.",
  },
  cigna: {
    heroDescription: "Upload the Cigna login workbook and claim workbook to search Cigna for Health Care Professionals by patient ID, patient name, DOS, and CPT.",
    processingDescription: "Cigna rows stream live progress and download an output workbook with claim, payment, procedure, and remark-code details.",
  },
  kaiser: {
    heroDescription: "Upload the Kaiser EpicLink login workbook and claim workbook to search claim status by Member ID, DOS, and CPT.",
    processingDescription: "Kaiser rows stream live progress and download an output workbook with claim, payment, service, and denial details.",
  },
  medpoint: {
    heroDescription: "Upload the Medpoint login workbook and claim workbook to start Medpoint claim status verification.",
    processingDescription: "Medpoint requests stream live progress and download claim status output when the run completes.",
  },
  "my-family": {
    heroDescription: "Upload the My family EZ-NET login workbook and claim workbook to search claims by Member ID or patient name and service date.",
    processingDescription: "My family rows stream live progress and download an output workbook with claim, status, payment, and service-line details.",
  },
  "optum-pro": {
    heroDescription: "Upload the One Healthcare ID login workbook and Optum Pro claim workbook, then enter OTP when prompted.",
    processingDescription: "Optum Pro streams progress, supports manual OTP entry, and downloads full or partial output workbooks.",
  },
  physicians: {
    heroDescription: "Upload the PHN QuickCap login workbook and claim workbook to search claims by Member ID and service date.",
    processingDescription: "Physicians rows stream live progress and download an output workbook with claim, payment, service-line, and authorization details.",
  },
  uhc: {
    heroDescription: "Upload your UHC login workbook and claim workbook to process UnitedHealthcare claim status checks for Minimax or MedRevenu.",
    processingDescription: "UHC requests stream live status, prompt for OTP or provider selection when needed, and update the selected workbook in place.",
  },
  waystar: {
    heroDescription: "Upload the Waystar login workbook and claim details workbook to begin claim status verification.",
    processingDescription: "Waystar streams live progress and produces an output workbook with the extracted claim status results.",
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

async function downloadStoredJobOutputOnce(jobId: string): Promise<string | null> {
  if (typeof window === "undefined" || !jobId) return null;
  const storageKey = `claim-status:auto-downloaded:${jobId}`;
  if (window.localStorage.getItem(storageKey) === "true") return null;
  const { filename, downloadUrl } = await getScrapeJobDownload(jobId);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = filename;
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.localStorage.setItem(storageKey, "true");
  return filename;
}
function downloadBase64File(filename: string, base64: string, type: string): void {
  const bytes = base64ToBytes(base64);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  downloadBlob(filename, new Blob([arrayBuffer], { type }));
}

function getEventRowIndex(eventData: ScrapeJobEvent): number {
  if (typeof eventData.index === "number") return eventData.index;
  if (typeof eventData.rowIndex === "number") return Math.max(0, eventData.rowIndex - 1);
  return -1;
}

function screenshotsFromArtifacts(currentJob: CurrentScrapeJob): ErrorScreenshot[] {
  return (currentJob.artifacts ?? [])
    .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
    .map((artifact) => ({
      index: artifact.rowIndex === null || artifact.rowIndex === undefined ? -1 : artifact.rowIndex,
      image: artifact.contentBase64 ?? "",
    }));
}

function downloadDebugHtmlArtifacts(currentJob: CurrentScrapeJob): void {
  for (const artifact of currentJob.artifacts ?? []) {
    if (artifact.artifactType !== "debug_html" || !artifact.contentText) continue;
    const artifactKey = `${artifact.artifactType}:${artifact.id}:${artifact.filename || artifact.createdAt}`;
    if (hasDownloadedArtifact(currentJob.jobId, artifactKey)) continue;
    downloadTextFile(
      artifact.filename || `debug_dom_line_${artifact.rowIndex === null || artifact.rowIndex === undefined ? "unknown" : artifact.rowIndex + 1}.html`,
      artifact.contentText,
      artifact.mimeType || "text/html",
    );
    rememberDownloadedArtifact(currentJob.jobId, artifactKey);
  }
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
    String(getEventRowIndex(eventData)),
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
  const worksheet = excelWb.worksheets[0];
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

async function loadUhcWorkbookBundle(claimFileHandle: FileSystemFileHandle, groupId: string): Promise<UhcWorkbookBundle> {
  const currentPermission = await claimFileHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as const);
  if (currentPermission !== "granted") {
    if ((await claimFileHandle.requestPermission({ mode: "readwrite" }).catch(() => "denied" as const)) !== "granted") {
      throw new Error("Write permission denied. Cannot update UHC Excel file.");
    }
  }

  const file = await claimFileHandle.getFile();
  const arrayBuffer = await file.arrayBuffer();
  const excelWb = new ExcelJS.Workbook();
  await excelWb.xlsx.load(arrayBuffer);
  const worksheet = excelWb.worksheets[0];
  if (!worksheet) {
    throw new Error("UHC claim Excel file does not contain a worksheet.");
  }

  const claimRows = parseUhcClaimRows(worksheet, {
    requirePatientDob: groupId !== "medrevenu",
  });
  if (claimRows.length === 0) {
    throw new Error("UHC claim Excel file contains no rows to process.");
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

async function cloneWorkbook(excelWb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buffer = await excelWb.xlsx.writeBuffer();
  const clonedWb = new ExcelJS.Workbook();
  await clonedWb.xlsx.load(buffer);
  return clonedWb;
}

async function writeIehpPostProcessedCheckpoint(
  claimFileHandle: FileSystemFileHandle,
  excelWb: ExcelJS.Workbook,
): Promise<void> {
  const checkpointWb = await cloneWorkbook(excelWb);
  const checkpointWorksheet = checkpointWb.getWorksheet(1);
  if (!checkpointWorksheet) {
    throw new Error("Claim Excel file does not contain a worksheet.");
  }
  postProcessWorksheet(checkpointWorksheet);
  await writeWorkbookToClaimFile(claimFileHandle, checkpointWb);
}

export function ClaimStatusPage({ forcedPortalId = null }: { forcedPortalId?: PortalId | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authStatus, setAuthStatus] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [activeView, setActiveView] = useState<"portal-selection" | "manage-users" | "reset-password" | "outputs">("portal-selection");
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
  const [aerialSubportal, setAerialSubportal] = useState<AerialSubportal | null>(null);
  const [availityProjectId, setAvailityProjectId] = useState("minimax");
  const [availityCredentialFile, setAvailityCredentialFile] = useState<File | null>(null);
  const [availityInputFile, setAvailityInputFile] = useState<File | null>(null);
  const [availityJobId, setAvailityJobId] = useState<string>("");
  const [availityOtpRequest, setAvailityOtpRequest] = useState<{ inputName: string; label: string; message: string } | null>(null);
  const [availityOtpValue, setAvailityOtpValue] = useState<string>("");
  const [waystarLoginFile, setWaystarLoginFile] = useState<File | null>(null);
  const [waystarInputFile, setWaystarInputFile] = useState<File | null>(null);
  const [astronaCredentialFile, setAstronaCredentialFile] = useState<File | null>(null);
  const [astronaInputFile, setAstronaInputFile] = useState<File | null>(null);
  const [astronaResults, setAstronaResults] = useState<Record<string, unknown>[]>([]);
  const [allCareCredentialFile, setAllCareCredentialFile] = useState<File | null>(null);
  const [allCareInputFile, setAllCareInputFile] = useState<File | null>(null);
  const [uhcLoginFile, setUhcLoginFile] = useState<File | null>(null);
  const [uhcClaimFileHandle, setUhcClaimFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [uhcClaimFileName, setUhcClaimFileName] = useState<string>("");
  const [uhcGroupId, setUhcGroupId] = useState("minimax");
  const [uhcBrowserType, setUhcBrowserType] = useState<"chrome" | "firefox">("chrome");
  const [uhcJobId, setUhcJobId] = useState<string>("");
  const [uhcOtpRequest, setUhcOtpRequest] = useState<{ inputName: string; label: string; message: string } | null>(null);
  const [uhcOtpValue, setUhcOtpValue] = useState<string>("");
  const [uhcProviderPrompt, setUhcProviderPrompt] = useState<UhcProviderPrompt | null>(null);
  const [cignaCredentialFile, setCignaCredentialFile] = useState<File | null>(null);
  const [cignaInputFile, setCignaInputFile] = useState<File | null>(null);
  const [cignaJobId, setCignaJobId] = useState<string>("");
  const [cignaOtpRequest, setCignaOtpRequest] = useState<{ inputName: string; label: string; message: string } | null>(null);
  const [cignaOtpValue, setCignaOtpValue] = useState<string>("");
  const [kaiserCredentialFile, setKaiserCredentialFile] = useState<File | null>(null);
  const [kaiserInputFile, setKaiserInputFile] = useState<File | null>(null);
  const [myFamilyCredentialFile, setMyFamilyCredentialFile] = useState<File | null>(null);
  const [myFamilyInputFile, setMyFamilyInputFile] = useState<File | null>(null);
  const [optumProLoginFile, setOptumProLoginFile] = useState<File | null>(null);
  const [optumProInputFile, setOptumProInputFile] = useState<File | null>(null);
  const [physiciansCredentialFile, setPhysiciansCredentialFile] = useState<File | null>(null);
  const [physiciansInputFile, setPhysiciansInputFile] = useState<File | null>(null);
  const [optumProJobId, setOptumProJobId] = useState<string>("");
  const [optumProOtpRequest, setOptumProOtpRequest] = useState<{ inputName: string; label: string; message: string } | null>(null);
  const [optumProOtpValue, setOptumProOtpValue] = useState<string>("");
  const [optumProStopping, setOptumProStopping] = useState(false);
  const [optumProStaleRunAvailable, setOptumProStaleRunAvailable] = useState(false);
  const [blueShieldCredentialFile, setBlueShieldCredentialFile] = useState<File | null>(null);
  const [blueShieldInputFile, setBlueShieldInputFile] = useState<File | null>(null);
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
  const [latestAvailityOutput, setLatestAvailityOutput] = useState<DownloadableArtifact | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [errorScreenshots, setErrorScreenshots] = useState<ErrorScreenshot[]>([]);
  const [progress, setProgress] = useState<JobProgressValue | null>(null);
  const [activeJobId, setActiveJobId] = useState<string>("");
  const [workflowRuns, setWorkflowRuns] = useState<ScrapeJobSummary[]>([]);
  const [workflowRunsLoading, setWorkflowRunsLoading] = useState(false);
  const [workflowRunsError, setWorkflowRunsError] = useState("");
  const [operationsRunningJobs, setOperationsRunningJobs] = useState<ScrapeJobSummary[]>([]);
  const [operationsRunningJobsLoading, setOperationsRunningJobsLoading] = useState(false);
  const [operationsRunningJobsError, setOperationsRunningJobsError] = useState("");
  const [forceStoppingWorkflowJobId, setForceStoppingWorkflowJobId] = useState("");
  const [selectedWorkflowRunId, setSelectedWorkflowRunId] = useState("");
  const [downloadingWorkflowJobId, setDownloadingWorkflowJobId] = useState("");
  const [cancellingWorkflowJobId, setCancellingWorkflowJobId] = useState("");
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
  const awsWorkflowMode = isAwsWorkflowMode();
  const authUsesCognito = awsWorkflowMode && isCognitoMode();
  const workflowRunTrackingEnabled = Boolean(authUser);
  const canViewOperationsRunningJobs = hasFullWorkflowAccess(authUser);
  const effectivePortalId = forcedPortalId ?? (pathname === "/claim-status" ? null : selectedPortalId);
  const availablePortals = useMemo(
    () => claimStatusPortalRegistry,
    [],
  );
  const selectedPortal =
    effectivePortalId === "iehp"
      ? iehpFrontendPortalConfig
      : effectivePortalId === "aerial"
        ? aerialFrontendPortalConfig
        : effectivePortalId === "all-care"
          ? allCareFrontendPortalConfig
        : effectivePortalId === "astrona"
          ? astronaFrontendPortalConfig
        : effectivePortalId === "regal"
          ? regalFrontendPortalConfig
          : effectivePortalId === "blue-shield"
            ? blueShieldFrontendPortalConfig
            : effectivePortalId === "availity"
              ? availityFrontendPortalConfig
              : effectivePortalId === "cigna"
                ? cignaFrontendPortalConfig
              : effectivePortalId === "kaiser"
                ? kaiserFrontendPortalConfig
              : effectivePortalId === "my-family"
                ? myFamilyFrontendPortalConfig
              : effectivePortalId === "optum-pro"
                ? optumProFrontendPortalConfig
              : effectivePortalId === "physicians"
                ? physiciansFrontendPortalConfig
              : effectivePortalId === "uhc"
                ? uhcFrontendPortalConfig
              : effectivePortalId === "waystar"
                ? waystarFrontendPortalConfig
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
  const visibleWorkflowRuns = useMemo(
    () =>
      workflowRuns.filter((job) =>
        isLiveWorkflowStatus(job.status),
      ),
    [workflowRuns],
  );
  const runningWorkflowRunCount = useMemo(
    () => visibleWorkflowRuns.length,
    [visibleWorkflowRuns],
  );
  const outputWorkflowRuns = useMemo(
    () =>
      workflowRuns.filter((job) =>
        hasExcelOutput(job),
      ),
    [workflowRuns],
  );
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
  const canStartAnotherRun = workflowRunTrackingEnabled || !isProcessing;
  const blockPortalFormForProcessing = isProcessing && !workflowRunTrackingEnabled;
  const canSubmitIehp = useMemo(
    () => Boolean(iehpLoginFile && claimFileHandle && canStartAnotherRun),
    [iehpLoginFile, claimFileHandle, canStartAnotherRun],
  );
  const selectedAerialSubportal = getAerialSubportal(aerialSubportal);
  const canSubmitAerial = useMemo(
    () => Boolean(
      selectedAerialSubportal
      && aerialInputFile
      && (!selectedAerialSubportal.requiresCredentialFile || aerialCredentialFile)
      && canStartAnotherRun,
    ),
    [aerialCredentialFile, aerialInputFile, selectedAerialSubportal, canStartAnotherRun],
  );
  const canSubmitAvaility = useMemo(
    () => Boolean(availityProjectId && availityCredentialFile && availityInputFile && canStartAnotherRun),
    [availityProjectId, availityCredentialFile, availityInputFile, canStartAnotherRun],
  );
  const canSubmitUhc = useMemo(
    () => Boolean(uhcLoginFile && uhcClaimFileHandle && canStartAnotherRun),
    [uhcClaimFileHandle, uhcLoginFile, canStartAnotherRun],
  );
  const canSubmitAstrona = useMemo(
    () => Boolean(astronaCredentialFile && astronaInputFile && canStartAnotherRun),
    [astronaCredentialFile, astronaInputFile, canStartAnotherRun],
  );
  const canSubmitAllCare = useMemo(
    () => Boolean(allCareCredentialFile && allCareInputFile && canStartAnotherRun),
    [allCareCredentialFile, allCareInputFile, canStartAnotherRun],
  );
  const canSubmitCigna = useMemo(
    () => Boolean(cignaCredentialFile && cignaInputFile && canStartAnotherRun),
    [cignaCredentialFile, cignaInputFile, canStartAnotherRun],
  );
  const canSubmitKaiser = useMemo(
    () => Boolean(kaiserCredentialFile && kaiserInputFile && canStartAnotherRun),
    [kaiserCredentialFile, kaiserInputFile, canStartAnotherRun],
  );
  const canSubmitMyFamily = useMemo(
    () => Boolean(myFamilyCredentialFile && myFamilyInputFile && canStartAnotherRun),
    [myFamilyCredentialFile, myFamilyInputFile, canStartAnotherRun],
  );
  const canSubmitOptumPro = useMemo(
    () => Boolean(optumProLoginFile && optumProInputFile && canStartAnotherRun),
    [optumProLoginFile, optumProInputFile, canStartAnotherRun],
  );
  const canSubmitPhysicians = useMemo(
    () => Boolean(physiciansCredentialFile && physiciansInputFile && canStartAnotherRun),
    [physiciansCredentialFile, physiciansInputFile, canStartAnotherRun],
  );
  const canSubmitRegal = useMemo(
    () => Boolean(regalClaimFile && canStartAnotherRun),
    [regalClaimFile, canStartAnotherRun],
  );
  const canSubmitBlueShield = useMemo(
    () => Boolean(blueShieldCredentialFile && blueShieldInputFile && canStartAnotherRun),
    [blueShieldCredentialFile, blueShieldInputFile, canStartAnotherRun],
  );
  const canSubmitWaystar = useMemo(
    () => Boolean(waystarLoginFile && waystarInputFile && canStartAnotherRun),
    [waystarInputFile, waystarLoginFile, canStartAnotherRun],
  );
  const currentCanSubmit =
    effectivePortalId === "iehp"
      ? canSubmitIehp
      : effectivePortalId === "aerial"
        ? canSubmitAerial
        : effectivePortalId === "all-care"
          ? canSubmitAllCare
        : effectivePortalId === "astrona"
          ? canSubmitAstrona
        : effectivePortalId === "regal"
          ? canSubmitRegal
          : effectivePortalId === "blue-shield"
            ? canSubmitBlueShield
            : effectivePortalId === "availity"
              ? canSubmitAvaility
              : effectivePortalId === "cigna"
                ? canSubmitCigna
              : effectivePortalId === "kaiser"
                ? canSubmitKaiser
              : effectivePortalId === "my-family"
                ? canSubmitMyFamily
              : effectivePortalId === "optum-pro"
                ? canSubmitOptumPro
              : effectivePortalId === "physicians"
                ? canSubmitPhysicians
              : effectivePortalId === "uhc"
                ? canSubmitUhc
              : effectivePortalId === "waystar"
                ? canSubmitWaystar
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

    if (effectivePortalId === "waystar") {
      return {
        claimFileLabel: waystarInputFile?.name ?? "",
        claimReady: Boolean(waystarInputFile),
        loginFileLabel: waystarLoginFile?.name ?? "",
        loginReady: Boolean(waystarLoginFile),
      };
    }

    if (effectivePortalId === "uhc") {
      return {
        claimFileLabel: uhcClaimFileName,
        claimReady: Boolean(uhcClaimFileHandle),
        loginFileLabel: uhcLoginFile?.name ?? "",
        loginReady: Boolean(uhcLoginFile),
      };
    }

    if (effectivePortalId === "astrona") {
      return {
        claimFileLabel: astronaInputFile?.name ?? "",
        claimReady: Boolean(astronaInputFile),
        loginFileLabel: astronaCredentialFile?.name ?? "",
        loginReady: Boolean(astronaCredentialFile),
      };
    }

    if (effectivePortalId === "all-care") {
      return {
        claimFileLabel: allCareInputFile?.name ?? "",
        claimReady: Boolean(allCareInputFile),
        loginFileLabel: allCareCredentialFile?.name ?? "",
        loginReady: Boolean(allCareCredentialFile),
      };
    }

    if (effectivePortalId === "cigna") {
      return {
        claimFileLabel: cignaInputFile?.name ?? "",
        claimReady: Boolean(cignaInputFile),
        loginFileLabel: cignaCredentialFile?.name ?? "",
        loginReady: Boolean(cignaCredentialFile),
      };
    }

    if (effectivePortalId === "kaiser") {
      return {
        claimFileLabel: kaiserInputFile?.name ?? "",
        claimReady: Boolean(kaiserInputFile),
        loginFileLabel: kaiserCredentialFile?.name ?? "",
        loginReady: Boolean(kaiserCredentialFile),
      };
    }

    if (effectivePortalId === "my-family") {
      return {
        claimFileLabel: myFamilyInputFile?.name ?? "",
        claimReady: Boolean(myFamilyInputFile),
        loginFileLabel: myFamilyCredentialFile?.name ?? "",
        loginReady: Boolean(myFamilyCredentialFile),
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

    if (effectivePortalId === "physicians") {
      return {
        claimFileLabel: physiciansInputFile?.name ?? "",
        claimReady: Boolean(physiciansInputFile),
        loginFileLabel: physiciansCredentialFile?.name ?? "",
        loginReady: Boolean(physiciansCredentialFile),
      };
    }

    if (effectivePortalId === "optum-pro") {
      return {
        claimFileLabel: optumProInputFile?.name ?? "",
        claimReady: Boolean(optumProInputFile),
        loginFileLabel: optumProLoginFile?.name ?? "",
        loginReady: Boolean(optumProLoginFile),
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
    allCareCredentialFile,
    allCareInputFile,
    availityCredentialFile,
    availityInputFile,
    astronaCredentialFile,
    astronaInputFile,
    blueShieldCredentialFile,
    blueShieldInputFile,
    cignaCredentialFile,
    cignaInputFile,
    claimFileName,
    effectivePortalId,
    iehpLoginFile,
    kaiserCredentialFile,
    kaiserInputFile,
    myFamilyCredentialFile,
    myFamilyInputFile,
    optumProInputFile,
    optumProLoginFile,
    physiciansCredentialFile,
    physiciansInputFile,
    regalClaimFile,
    regalLoginFile,
    uhcClaimFileHandle,
    uhcClaimFileName,
    uhcLoginFile,
    waystarInputFile,
    waystarLoginFile,
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

  function navigateToPortalRoute(portalId: PortalId, replace = false) {
    const targetRoute = PORTAL_ROUTE_MAP[portalId];
    if (pathname !== targetRoute) {
      if (replace) {
        router.replace(targetRoute);
      } else {
        router.push(targetRoute);
      }
    }
  }

  function updateAuthUser(nextUser: AuthUser | null) {
    setAuthUser(nextUser);
    persistCachedAuthUser(nextUser);
  }

  function handleAwsAuthFailure(error: unknown): boolean {
    if (!authUsesCognito || !(error instanceof ScrapeJobAuthError)) return false;
    clearCognitoAccessToken();
    updateAuthUser(null);
    setWorkflowRuns([]);
    setWorkflowRunsError("");
    setOperationsRunningJobs([]);
    setOperationsRunningJobsError("");
    setIsProcessing(false);
    redirectToCognitoLogin();
    return true;
  }

  function markSkipJobRestoreOnce() {
    try {
      window.sessionStorage.setItem(SKIP_JOB_RESTORE_ONCE_KEY, "true");
    } catch {
      // Ignore storage failures.
    }
  }

  useEffect(() => {
    if (authUsesCognito) {
      const hasToken = storeCognitoTokenFromHash() || Boolean(getCognitoAccessToken());
      if (hasToken) {
        const profile = getCognitoUserProfile();
        updateAuthUser({
          userId: profile?.userId || "cognito",
          username: profile?.username || "Cognito user",
          email: profile?.email || "Signed in with Cognito",
          role: profile?.role || "USER",
          mustResetPassword: false,
        });
      } else {
        updateAuthUser(null);
      }
      setAuthLoading(false);
      return;
    }

    let mounted = true;

    fetch("/api/auth/me")
      .then(async (response) => {
        if (!mounted) return;
        if (!response.ok) {
          updateAuthUser(null);
          return;
        }
        const data = await response.json();
        updateAuthUser(data.user ?? null);
      })
      .catch(() => {
        if (mounted) updateAuthUser(null);
      })
      .finally(() => {
        if (mounted) setAuthLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [authUsesCognito]);

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
        if (pathname === "/claim-status") return;
        if (forcedPortalId && currentJob.portalId !== forcedPortalId) return;

        setErrorScreenshots(screenshotsFromArtifacts(currentJob));
        if (currentJob.portalId === "iehp") {
          downloadDebugHtmlArtifacts(currentJob);
        }
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
          setStatus("A previous Blue Shield run is still active. Use the active-runs table to view or cancel that specific run.");
          return;
        }

        setStatus(`Reconnected to ${currentJob.portalId.toUpperCase()} run in progress...`);
        setIsProcessing(true);
        setActiveJobId(currentJob.jobId);
        setSelectedPortalId(currentJob.portalId as PortalId);
        navigateToPortalRoute(currentJob.portalId as PortalId, true);
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
        } else if (currentJob.portalId === "astrona") {
          await reconnectDownloadOnlyRun(currentJob, "astrona", "Astrona");
        } else if (currentJob.portalId === "cigna") {
          await reconnectDownloadOnlyRun(currentJob, "cigna", "Cigna");
        } else if (currentJob.portalId === "kaiser") {
          await reconnectDownloadOnlyRun(currentJob, "kaiser", "Kaiser");
        } else if (currentJob.portalId === "my-family") {
          await reconnectDownloadOnlyRun(currentJob, "my-family", "My family");
        } else if (currentJob.portalId === "physicians") {
          await reconnectDownloadOnlyRun(currentJob, "physicians", "Physicians");
        } else if (currentJob.portalId === "regal") {
          await reconnectRegalRun(currentJob);
        } else if (currentJob.portalId === "optum-pro") {
          await reconnectOptumProRun(currentJob);
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
  }, [authUser, forcedPortalId, pathname]);

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
    if (!authUser || authUser.mustResetPassword || pathname !== "/claim-status") return;
    const requestedView = new URLSearchParams(window.location.search).get("view");
    if (requestedView === "reset-password") {
      void openResetPassword();
    } else if (requestedView === "manage-users" && hasFullWorkflowAccess(authUser)) {
      void openManageUsers();
    }
  }, [authUser, pathname]);

  useEffect(() => {
    if (forcedPortalId) {
      setSelectedPortalId(forcedPortalId);
      return;
    }

    if (pathname === "/claim-status" || !authUser || authUser.mustResetPassword || selectedPortalId) {
      return;
    }

    try {
      const storedPortalId = window.localStorage.getItem(SELECTED_PORTAL_STORAGE_KEY);
      if (storedPortalId && isPortalId(storedPortalId)) {
        setSelectedPortalId(storedPortalId);
        navigateToPortalRoute(storedPortalId, true);
      }
    } catch {
      // Ignore storage failures.
    }
  }, [authUser, selectedPortalId, forcedPortalId, pathname]);

  useEffect(() => {
    if (!isProcessing || !activeJobId) return;

    let cancelled = false;
    const synchronizeActiveJobProgress = async () => {
      const details = await getScrapeJobDetails(activeJobId).catch(() => null);
      if (cancelled || !details) return;
      if (details.totalRows > 0) {
        setProgress((previous) => {
          const previousCompleted = previous?.completed ?? 0;
          const completed = Math.max(previousCompleted, details.currentCompleted);
          return {
            completed,
            total: details.totalRows,
            currentRow: details.currentCompleted > previousCompleted ? undefined : previous?.currentRow,
          };
        });
      }
      if (isTerminalWorkflowStatus(details.status)) {
        try {
          const filename = await downloadStoredJobOutputOnce(details.jobId);
          setStatus(filename
            ? `${details.portalId.toUpperCase()} run finished. Download started for ${filename}.`
            : `${details.portalId.toUpperCase()} run ${formatShortJobId(details.jobId)} is ${details.status.replace(/_/g, " ")}.`);
        } catch (error) {
          setStatus(`${details.portalId.toUpperCase()} run finished, but automatic output download failed: ${getErrorMessage(error)}`);
        }
        setIsProcessing(false);
      }
    };

    void synchronizeActiveJobProgress();
    const timer = window.setInterval(() => void synchronizeActiveJobProgress(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJobId, isProcessing]);
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

  async function refreshWorkflowRuns(options?: { silent?: boolean }) {
    if (!workflowRunTrackingEnabled) {
      setWorkflowRuns([]);
      return;
    }

    if (!options?.silent) {
      setWorkflowRunsLoading(true);
      setWorkflowRunsError("");
    }

    try {
      const jobs = await listScrapeJobs(50);
      setWorkflowRuns(jobs);
      setWorkflowRunsError("");
      setDashboardStatsData((current) => ({
        ...current,
        runningJobs: jobs.filter((job) => isLiveWorkflowStatus(job.status)).length,
      }));
    } catch (error) {
      if (handleAwsAuthFailure(error)) return;
      setWorkflowRunsError(getErrorMessage(error));
    } finally {
      if (!options?.silent) {
        setWorkflowRunsLoading(false);
      }
    }
  }

  async function refreshOperationsRunningJobs(options?: { silent?: boolean }) {
    if (!canViewOperationsRunningJobs) {
      setOperationsRunningJobs([]);
      setOperationsRunningJobsError("");
      return;
    }

    if (!options?.silent) {
      setOperationsRunningJobsLoading(true);
      setOperationsRunningJobsError("");
    }

    try {
      const jobs = await listScrapeJobs(50, { scope: "all-running" });
      setOperationsRunningJobs(jobs.filter((job) => isLiveWorkflowStatus(job.status)));
      setOperationsRunningJobsError("");
    } catch (error) {
      if (handleAwsAuthFailure(error)) return;
      setOperationsRunningJobsError(getErrorMessage(error));
    } finally {
      if (!options?.silent) {
        setOperationsRunningJobsLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!workflowRunTrackingEnabled) return;
    let cancelled = false;

    const load = async (silent: boolean) => {
      if (cancelled) return;
      await refreshWorkflowRuns({ silent });
    };

    void load(false);
    const interval = window.setInterval(() => {
      void load(true);
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workflowRunTrackingEnabled, authUser?.userId]);

  useEffect(() => {
    if (!canViewOperationsRunningJobs) {
      setOperationsRunningJobs([]);
      return;
    }
    let cancelled = false;

    const load = async (silent: boolean) => {
      if (cancelled) return;
      await refreshOperationsRunningJobs({ silent });
    };

    void load(false);
    const interval = window.setInterval(() => {
      void load(true);
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [canViewOperationsRunningJobs, authUser?.userId]);

  useEffect(() => {
    if (!selectedWorkflowRunId) return;
    const selectedRun = [...workflowRuns, ...operationsRunningJobs].find((job) => job.jobId === selectedWorkflowRunId);
    if (!selectedRun || !isLiveWorkflowStatus(selectedRun.status)) return;

    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await loadWorkflowRunDetails(selectedRun);
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedWorkflowRunId, workflowRuns, operationsRunningJobs]);

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
    setAstronaResults([]);
    setActiveJobId("");
    setAvailityJobId("");
    setAvailityOtpRequest(null);
    setAvailityOtpValue("");
    setUhcJobId("");
    setUhcOtpRequest(null);
    setUhcOtpValue("");
    setUhcProviderPrompt(null);
    setRegalJobId("");
    setRegalMfaRequest(null);
    setRegalMfaValue("");
    setRegalOtpRequest(null);
    setRegalOtpValue("");
    setBlueShieldJobId("");
    setBlueShieldOtpRequest(null);
    setBlueShieldOtpValue("");
    setCignaJobId("");
    setCignaOtpRequest(null);
    setCignaOtpValue("");
    setOptumProJobId("");
    setOptumProOtpRequest(null);
    setOptumProOtpValue("");
    setOptumProStopping(false);
    setOptumProStaleRunAvailable(false);
    setLatestRegalOutput(null);
    setLatestAvailityOutput(null);
  }

  function resetPortalSelection() {
    setActiveView("portal-selection");
    setSettingsOpen(false);
    if (forcedPortalId) {
      try {
        window.localStorage.removeItem(SELECTED_PORTAL_STORAGE_KEY);
      } catch {
        // Ignore storage failures.
      }
      markSkipJobRestoreOnce();
      window.location.replace("/claim-status");
      return;
    }
    setSelectedPortalId(null);
    markSkipJobRestoreOnce();
    try {
      window.localStorage.removeItem(SELECTED_PORTAL_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
    setStatus("");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
    setAstronaResults([]);
    setIsProcessing(false);
    setActiveJobId("");
    setPendingIehpRestoreJob(null);
    setPendingRegalRestoreJob(null);
    setPendingBlueShieldRestoreJob(null);
    setRegalJobId("");
    setUhcJobId("");
    setUhcOtpRequest(null);
    setUhcOtpValue("");
    setUhcProviderPrompt(null);
    setRegalMfaRequest(null);
    setRegalMfaValue("");
    setRegalOtpRequest(null);
    setRegalOtpValue("");
    setBlueShieldJobId("");
    setBlueShieldOtpRequest(null);
    setBlueShieldOtpValue("");
    setCignaJobId("");
    setCignaOtpRequest(null);
    setCignaOtpValue("");
    setCignaCredentialFile(null);
    setCignaInputFile(null);
    setKaiserCredentialFile(null);
    setKaiserInputFile(null);
    setMyFamilyCredentialFile(null);
    setMyFamilyInputFile(null);
    setPhysiciansCredentialFile(null);
    setPhysiciansInputFile(null);
    setOptumProJobId("");
    setOptumProOtpRequest(null);
    setOptumProOtpValue("");
    setOptumProStopping(false);
    setOptumProStaleRunAvailable(false);
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
      updateAuthUser(nextUser);
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
    if (isCognitoMode()) {
      await clearStoredRunContext().catch(() => {});
      updateAuthUser(null);
      redirectToCognitoLogout();
      return;
    }

    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    await clearStoredRunContext().catch(() => {});
    updateAuthUser(null);
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
    setAerialSubportal(null);
    setAstronaCredentialFile(null);
    setAstronaInputFile(null);
    setBlueShieldCredentialFile(null);
    setBlueShieldInputFile(null);
    setBlueShieldResetCheckpoint(false);
    setBlueShieldJobId("");
    setBlueShieldOtpRequest(null);
    setBlueShieldOtpValue("");
    setCignaCredentialFile(null);
    setCignaInputFile(null);
    setCignaJobId("");
    setCignaOtpRequest(null);
    setCignaOtpValue("");
    setKaiserCredentialFile(null);
    setKaiserInputFile(null);
    setMyFamilyCredentialFile(null);
    setMyFamilyInputFile(null);
    setPhysiciansCredentialFile(null);
    setPhysiciansInputFile(null);
    setOptumProLoginFile(null);
    setOptumProInputFile(null);
    setOptumProJobId("");
    setOptumProOtpRequest(null);
    setOptumProOtpValue("");
    setOptumProStopping(false);
    setOptumProStaleRunAvailable(false);
    setIsProcessing(false);
    setStatus("");
    setLogs([]);
    setErrorScreenshots([]);
    setProgress(null);
    setAstronaResults([]);
    setActiveJobId("");
    setWorkflowRuns([]);
    setWorkflowRunsError("");
    setSelectedWorkflowRunId("");
    setPendingIehpRestoreJob(null);
    setPendingBlueShieldRestoreJob(null);
  }

  async function loadWorkflowRunDetails(job: ScrapeJobSummary) {
    try {
      const details = await getScrapeJobDetails(job.jobId);
      setLogs(details.logs);
      setProgress(details.totalRows > 0 ? { completed: details.currentCompleted, total: details.totalRows } : null);
      setStatus(
        `${details.portalId.toUpperCase()} run ${formatShortJobId(details.jobId)} is ${details.status.replace(/_/g, " ")}.`,
      );
    } catch (error) {
      setStatus(`Failed to load run ${formatShortJobId(job.jobId)}: ${getErrorMessage(error)}`);
    }
  }

  async function selectWorkflowRun(job: ScrapeJobSummary) {
    setSelectedWorkflowRunId(job.jobId);
    setSelectedPortalId(isPortalId(job.portalId) ? job.portalId : null);
    if (isPortalId(job.portalId)) {
      navigateToPortalRoute(job.portalId);
    }
    setActiveJobId(job.jobId);
    setProgress(job.totalRows > 0 ? { completed: job.currentCompleted, total: job.totalRows } : null);
    setStatus(
      `${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)} is ${job.status.replace(/_/g, " ")}.`,
    );
    await loadWorkflowRunDetails(job);
  }

  async function cancelWorkflowRun(job: ScrapeJobSummary) {
    if (isTerminalWorkflowStatus(job.status) || cancellingWorkflowJobId) return;

    setCancellingWorkflowJobId(job.jobId);
    setStatus(`Cancelling ${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)}...`);
    try {
      await cancelScrapeJobRequest(job.jobId);
      await refreshWorkflowRuns({ silent: true });
      await refreshOperationsRunningJobs({ silent: true });
      if (activeJobId === job.jobId) {
        setActiveJobId("");
        setIsProcessing(false);
      }
      setStatus(`Cancel requested for ${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)}.`);
    } catch (error) {
      setStatus(`Failed to cancel run ${formatShortJobId(job.jobId)}: ${getErrorMessage(error)}`);
    } finally {
      setCancellingWorkflowJobId("");
    }
  }

  async function forceStopWorkflowRun(job: ScrapeJobSummary) {
    if (!canViewOperationsRunningJobs || isTerminalWorkflowStatus(job.status) || forceStoppingWorkflowJobId) return;

    setForceStoppingWorkflowJobId(job.jobId);
    setStatus(`Force-stopping ${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)}...`);
    try {
      await forceStopScrapeJob(job.jobId);
      await refreshWorkflowRuns({ silent: true });
      await refreshOperationsRunningJobs({ silent: true });
      if (activeJobId === job.jobId) {
        setActiveJobId("");
        setIsProcessing(false);
        setStatus("Processing force-stopped.");
      }
    } catch (error) {
      setStatus(`Failed to force-stop ${job.portalId.toUpperCase()} run: ${getErrorMessage(error)}`);
    } finally {
      setForceStoppingWorkflowJobId("");
    }
  }

  async function downloadWorkflowRun(job: ScrapeJobSummary) {
    if (downloadingWorkflowJobId) return;

    setDownloadingWorkflowJobId(job.jobId);
    setStatus(`Preparing download for ${job.portalId.toUpperCase()} run ${formatShortJobId(job.jobId)}...`);
    try {
      const { filename, downloadUrl } = await getScrapeJobDownload(job.jobId);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.rel = "noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setStatus(`Download started for ${filename}.`);
    } catch (error) {
      setStatus(`Failed to download run ${formatShortJobId(job.jobId)}: ${getErrorMessage(error)}`);
    } finally {
      setDownloadingWorkflowJobId("");
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
    setAstronaResults([]);
    setActiveJobId("");
    setPendingBlueShieldRestoreJob(null);
    setIsProcessing(false);
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
      updateAuthUser(nextUser);
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
            setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
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
          } else if (eventData.type === "error_screenshot" && eventData.image) {
            setErrorScreenshots((prev) => [...prev, { index: getEventRowIndex(eventData), image: eventData.image ?? "" }]);
          } else if (eventData.type === "debug_html" && eventData.html) {
            const artifactKey = buildDownloadArtifactKey(eventData);
            if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
              const rowIndex = getEventRowIndex(eventData);
              downloadTextFile(eventData.filename || `debug_dom_line_${rowIndex >= 0 ? rowIndex + 1 : "unknown"}.html`, eventData.html, "text/html");
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
          setIehpLoginFile(null);
          setClaimFileHandle(null);
          setClaimFileName("");
          setIsProcessing(false);
          void refreshWorkflowRuns({ silent: true });
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
        if (!chunkHasError) {
          try {
            setStatus(`Saving IEHP checkpoint after row ${currentCompleted}...`);
            await writeIehpPostProcessedCheckpoint(options.claimFileHandle, excelWb);
          } catch (checkpointError) {
            console.error("Failed to write IEHP checkpoint:", checkpointError);
            handleWriteFailure(checkpointError);
          }
        }
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
    const subscribedJobId = "";
    const streamAbortController = new AbortController();

    try {
      await subscribeToScrapeJobEvents({
        jobId: currentJob.jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          if (eventData.type === "log" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
          } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
            setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
          } else if (eventData.type === "row_progress" && typeof eventData.current === "number" && typeof eventData.total === "number") {
            setProgress({ completed: Math.max(0, eventData.current - 1), total: eventData.total, currentRow: eventData.current });
            setStatus(`Aerial processing row ${eventData.current} of ${eventData.total}: ${eventData.payerName || "Unknown payer"}${eventData.stage ? ` (${eventData.stage})` : ""}.`);
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
    const latestSnapshot = [...(currentJob.artifacts ?? [])]
      .reverse()
      .find((artifact) => artifact.artifactType === "output_snapshot" && artifact.contentBase64 && artifact.filename);
    if (portalId === "availity" && latestSnapshot?.contentBase64 && latestSnapshot.filename) {
      setLatestAvailityOutput({
        filename: latestSnapshot.filename,
        base64: latestSnapshot.contentBase64,
        mimeType: latestSnapshot.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        completed: currentJob.currentCompleted,
        total: currentJob.totalRows,
      });
    }
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
            setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
          } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
            setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
          } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
            const artifactKey = buildDownloadArtifactKey(eventData);
            if (!hasDownloadedArtifact(currentJob.jobId, artifactKey)) {
              downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
              rememberDownloadedArtifact(currentJob.jobId, artifactKey);
              setStatus(`Downloaded ${eventData.filename}`);
            }
          } else if (eventData.type === "output_snapshot" && eventData.filename && eventData.base64) {
            if (portalId === "availity") {
              setLatestAvailityOutput({
                filename: eventData.filename,
                base64: eventData.base64,
                mimeType: eventData.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                completed: eventData.completed,
                total: eventData.total,
              });
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
            setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
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
        setRegalLoginFile(null);
        setRegalClaimFile(null);
        void refreshWorkflowRuns({ silent: true });
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

  async function reconnectOptumProRun(currentJob: CurrentScrapeJob) {
    setIsProcessing(true);
    setActiveJobId(currentJob.jobId);
    setSelectedPortalId("optum-pro");
    setOptumProJobId(currentJob.jobId);
    setOptumProStaleRunAvailable(false);
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
    setStatus("Reconnecting to current Optum Pro processing run...");

    let hasError = false;
    let finalErrorMessage = "";
    const streamAbortController = new AbortController();

    try {
      await subscribeToScrapeJobEvents({
        jobId: currentJob.jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          await handleOptumProJobEvent(eventData, currentJob.jobId, (message) => {
            finalErrorMessage = message;
            hasError = true;
          });
        },
        onStreamError(error) {
          console.error("Optum Pro stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });

      setStatus(
        hasError
          ? `Optum Pro processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Optum Pro processing completed.",
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
      setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
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

  async function handleOptumProJobEvent(
    eventData: ScrapeJobEvent,
    jobId: string,
    onError: (message: string) => void,
  ) {
    if (eventData.type === "log" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
    } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
      setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
    } else if (eventData.type === "job_metadata") {
      const metadata = eventData as Record<string, unknown>;
      if (typeof metadata.processedRows !== "number" || typeof metadata.totalRows !== "number") return;
      setProgress({ completed: metadata.processedRows, total: metadata.totalRows });
      if (Boolean(metadata.stopped) && Boolean(metadata.partialOutputAvailable)) {
        setStatus(`Stopped. Partial Excel ready for ${metadata.processedRows} of ${metadata.totalRows} rows.`);
      }
    } else if (eventData.type === "input_request" && eventData.inputName) {
      setOptumProOtpRequest({
        inputName: eventData.inputName,
        label: eventData.label || "Enter Optum Pro verification code",
        message: eventData.message || "Enter the One Healthcare ID text-message OTP.",
      });
      setOptumProOtpValue("");
      setStatus(eventData.message || "Waiting for Optum Pro verification code.");
    } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
      setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
    } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (!hasDownloadedArtifact(jobId, artifactKey)) {
        downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
        rememberDownloadedArtifact(jobId, artifactKey);
        setStatus(
          String(eventData.filename).includes("partial")
            ? `Partial Excel downloaded: ${eventData.filename}`
            : `Downloaded ${eventData.filename}`,
        );
      }
    } else if (eventData.type === "debug_html" && typeof eventData.index === "number" && eventData.html) {
      const artifactKey = buildDownloadArtifactKey(eventData);
      if (!hasDownloadedArtifact(jobId, artifactKey)) {
        downloadTextFile(eventData.filename || `optum_pro_debug_${eventData.index + 1}.html`, eventData.html, "text/html");
        rememberDownloadedArtifact(jobId, artifactKey);
      }
    } else if (eventData.type === "warning" && eventData.message) {
      setLogs((prev) => [...prev, eventData.message ?? ""]);
      setStatus(eventData.message);
    } else if (eventData.type === "cancelled") {
      const message = eventData.message || "Optum Pro scraping stopped.";
      setOptumProStopping(false);
      setOptumProStaleRunAvailable(false);
      setIsProcessing(false);
      setOptumProOtpRequest(null);
      setLogs((prev) => [...prev, message]);
      setStatus(String(message).startsWith("Stopped") ? message : `Stopped. ${message}`);
    } else if (eventData.type === "error" && eventData.message) {
      onError(eventData.message);
      setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
      setStatus(`Error: ${eventData.message}`);
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

    if (!aerialSubportal) {
      setStatus("Please select PMG or Citrus Valley.");
      return;
    }

    const subportalDefinition = getAerialSubportal(aerialSubportal);
    if (subportalDefinition?.requiresCredentialFile && !aerialCredentialFile) {
      setStatus(`Please provide the Aerial login Excel containing the ${subportalDefinition.label} row.`);
      return;
    }

    resetRunState("Starting Aerial scraper...");

    const formData = new FormData();
    formData.append("portalId", "aerial");
    formData.append("aerialSubportal", aerialSubportal);
    if (aerialCredentialFile) {
      formData.append("credentialExcel", aerialCredentialFile);
      formData.append("loginFileName", aerialCredentialFile.name);
    }
    formData.append("inputExcel", aerialInputFile);
    formData.append("claimFileName", aerialInputFile.name);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
      } else if (eventData.type === "row_progress" && typeof eventData.current === "number" && typeof eventData.total === "number") {
        setProgress({ completed: Math.max(0, eventData.current - 1), total: eventData.total, currentRow: eventData.current });
        setStatus(`Availity processing row ${eventData.current} of ${eventData.total}: ${eventData.payerName || "Unknown payer"}${eventData.stage ? ` (${eventData.stage})` : ""}.`);
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "otp_request" && eventData.inputName) {
        setAvailityOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Availity OTP",
          message: eventData.message || "Enter the Availity verification code.",
        });
        setAvailityOtpValue("");
        setStatus(eventData.message || "Enter the Availity verification code.");
      } else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
        const artifactKey = buildDownloadArtifactKey(eventData);
        if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
          downloadBase64File(eventData.filename, eventData.base64, eventData.mimeType || "application/octet-stream");
          rememberDownloadedArtifact(subscribedJobId, artifactKey);
          setStatus(`Downloaded ${eventData.filename}`);
        }
      } else if (eventData.type === "output_snapshot" && eventData.filename && eventData.base64) {
        setLatestAvailityOutput({
          filename: eventData.filename,
          base64: eventData.base64,
          mimeType: eventData.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          completed: eventData.completed,
          total: eventData.total,
        });
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
      setAvailityJobId(jobId);
      setAerialCredentialFile(null);
      setAerialInputFile(null);
      void refreshWorkflowRuns({ silent: true });
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
      setAvailityJobId("");
    }
  }

  async function submitAvailityOtp() {
    if (!availityJobId || !availityOtpRequest || !availityOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: availityJobId,
        inputName: availityOtpRequest.inputName,
        value: availityOtpValue.trim(),
      });
      setAvailityOtpRequest(null);
      setAvailityOtpValue("");
      setStatus("Availity verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit Availity OTP: ${getErrorMessage(error)}`);
    }
  }

  async function selectUhcClaimFile() {
    try {
      const handle = await selectExcelFileHandle();
      if (!handle) return;
      const file = await handle.getFile();
      setUhcClaimFileHandle(handle);
      setUhcClaimFileName(file.name);
    } catch (error) {
      setStatus(`Unable to select UHC claim file: ${getErrorMessage(error)}`);
    }
  }

  async function submitUhcOtp() {
    if (!uhcJobId || !uhcOtpRequest || !uhcOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: uhcJobId,
        inputName: uhcOtpRequest.inputName,
        value: uhcOtpValue.trim(),
      });
      setUhcOtpRequest(null);
      setUhcOtpValue("");
      setStatus("UHC verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit UHC OTP: ${getErrorMessage(error)}`);
    }
  }

  async function submitUhcProviderSelection() {
    if (!uhcJobId || !uhcProviderPrompt?.value) return;

    const value = uhcProviderPrompt.providerStage === "corporate"
      ? JSON.stringify({ corporateTaxIdOwner: uhcProviderPrompt.value })
      : JSON.stringify({ careProvider: uhcProviderPrompt.value });

    try {
      await submitScrapeJobInput({
        jobId: uhcJobId,
        inputName: uhcProviderPrompt.inputName,
        value,
      });
      setUhcProviderPrompt(null);
      setStatus("UHC provider selection submitted.");
    } catch (error) {
      setStatus(`Failed to submit UHC provider selection: ${getErrorMessage(error)}`);
    }
  }

  async function submitUhc(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!uhcLoginFile || !uhcClaimFileHandle) {
      setStatus("Please provide both the UHC login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting UHC scraper...");
    setSelectedPortalId("uhc");

    let workbookBundle: UhcWorkbookBundle;
    try {
      workbookBundle = await loadUhcWorkbookBundle(uhcClaimFileHandle, uhcGroupId);
    } catch (error) {
      setStatus(`Unable to read UHC claim workbook: ${getErrorMessage(error)}`);
      setIsProcessing(false);
      return;
    }

    const formData = new FormData();
    formData.append("portalId", "uhc");
    formData.append("loginExcel", uhcLoginFile);
    formData.append("loginFileName", uhcLoginFile.name);
    formData.append("claimFileName", uhcClaimFileName);
    formData.append("claimRows", JSON.stringify(workbookBundle.claimRows));
    formData.append("startIndex", "0");
    formData.append("attempt", "1");
    formData.append("browserType", uhcBrowserType);
    formData.append("clientType", uhcGroupId);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    let writeQueue = Promise.resolve();
    let uhcRowsSinceCheckpoint = 0;
    const streamAbortController = new AbortController();

    const failForWriteError = (error: unknown) => {
      const message = `UHC Excel update failed. Close Excel, verify file access, and run again. Details: ${getErrorMessage(error)}`;
      hasError = true;
      setStatus(`Error: ${message}`);
      streamAbortController.abort();
      if (subscribedJobId) {
        void cancelScrapeJobRequest(subscribedJobId).catch((cancelError) => {
          console.error("Failed to cancel UHC job after Excel write failure", cancelError);
        });
      }
      window.alert(message);
    };

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total });
      } else if (eventData.type === "row_update") {
        applyUhcRowUpdateToWorksheet(workbookBundle.worksheet, eventData);
        uhcRowsSinceCheckpoint += 1;
        const shouldWriteFullUhcCheckpoint = uhcRowsSinceCheckpoint >= 10;
        if (shouldWriteFullUhcCheckpoint) {
          uhcRowsSinceCheckpoint = 0;
        }
        writeQueue = writeQueue.then(async () => {
          try {
            if (shouldWriteFullUhcCheckpoint) {
              postProcessUhcWorksheet(workbookBundle.worksheet);
            }
            await writeWorkbookToClaimFile(uhcClaimFileHandle, workbookBundle.excelWb);
          } catch (writeError) {
            failForWriteError(writeError);
          }
        });
      } else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) {
        setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
      } else if (eventData.type === "debug_html" && typeof eventData.index === "number" && eventData.html) {
        const artifactKey = buildDownloadArtifactKey(eventData);
        if (!hasDownloadedArtifact(subscribedJobId, artifactKey)) {
          const rowIndex = getEventRowIndex(eventData);
          downloadTextFile(eventData.filename || `uhc_debug_line_${rowIndex >= 0 ? rowIndex + 1 : "unknown"}.html`, eventData.html, "text/html");
          rememberDownloadedArtifact(subscribedJobId, artifactKey);
        }
      } else if (eventData.type === "otp_request" && eventData.inputName) {
        setUhcOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "UHC OTP",
          message: eventData.message || "Enter the UHC verification code.",
        });
        setUhcOtpValue("");
        setStatus(eventData.message || "Enter the UHC verification code.");
      } else if (eventData.type === "provider_options" && eventData.inputName) {
        const providerStage = eventData.providerStage === "care" ? "care" : "corporate";
        const options = providerStage === "corporate" ? eventData.corporateTaxIdOwners ?? [] : eventData.careProviders ?? [];
        setUhcProviderPrompt({
          inputName: eventData.inputName,
          providerStage,
          corporateTaxIdOwners: eventData.corporateTaxIdOwners ?? [],
          careProviders: eventData.careProviders ?? [],
          value: options[0] ?? "",
          label: eventData.label || (providerStage === "corporate" ? "Corporate Tax ID Owner" : "Care Provider"),
          message: eventData.message || "Select an option to continue UHC automation.",
        });
        setStatus(eventData.message || "Select an option to continue UHC automation.");
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
      setUhcJobId(jobId);
      setUhcLoginFile(null);
      setUhcClaimFileHandle(null);
      setUhcClaimFileName("");
      setIsProcessing(false);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("UHC stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });

      await writeQueue;
      if (!hasError && !wasCancelled) {
        postProcessUhcWorksheet(workbookBundle.worksheet);
        await writeWorkbookToClaimFile(uhcClaimFileHandle, workbookBundle.excelWb);
      } else if (uhcRowsSinceCheckpoint > 0) {
        postProcessUhcWorksheet(workbookBundle.worksheet);
        await writeWorkbookToClaimFile(uhcClaimFileHandle, workbookBundle.excelWb);
        uhcRowsSinceCheckpoint = 0;
      }

      setStatus(
        wasCancelled
          ? "UHC processing cancelled."
          : hasError
            ? `UHC processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
            : "UHC processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process UHC claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
      setUhcJobId("");
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
    formData.append("projectId", availityProjectId);
    formData.append("credentialExcel", availityCredentialFile);
    formData.append("inputExcel", availityInputFile);
    formData.append("loginFileName", availityCredentialFile.name);
    formData.append("claimFileName", availityInputFile.name);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
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
      setAvailityCredentialFile(null);
      setAvailityInputFile(null);
      void refreshWorkflowRuns({ silent: true });
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

  async function submitWaystar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!waystarLoginFile || !waystarInputFile) {
      setStatus("Please provide both the Waystar login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting Waystar processing...");

    const formData = new FormData();
    formData.append("portalId", "waystar");
    formData.append("loginExcel", waystarLoginFile);
    formData.append("inputExcel", waystarInputFile);
    formData.append("loginFileName", waystarLoginFile.name);
    formData.append("claimFileName", waystarInputFile.name);

    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    const handleJobEvent = async (eventData: ScrapeJobEvent) => {
      if (eventData.type === "log" && eventData.message) {
        setLogs((prev) => [...prev, eventData.message ?? ""]);
      } else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") {
        setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
        setStatus(`Waystar processing ${eventData.completed} of ${eventData.total} row(s)...`);
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
      setWaystarLoginFile(null);
      setWaystarInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Waystar stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        wasCancelled
          ? "Waystar processing cancelled."
          : hasError
          ? `Waystar processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Waystar processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Waystar claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitKaiser(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!kaiserCredentialFile || !kaiserInputFile) {
      setStatus("Please provide both the Kaiser login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting Kaiser scraper...");

    const formData = new FormData();
    formData.append("portalId", "kaiser");
    formData.append("credentialExcel", kaiserCredentialFile);
    formData.append("inputExcel", kaiserInputFile);
    formData.append("loginFileName", kaiserCredentialFile.name);
    formData.append("claimFileName", kaiserInputFile.name);

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
      setKaiserCredentialFile(null);
      setKaiserInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Kaiser stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        wasCancelled
          ? "Kaiser processing cancelled."
          : hasError
            ? `Kaiser processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
            : "Kaiser processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Kaiser claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitCigna(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!cignaCredentialFile || !cignaInputFile) {
      setStatus("Please provide both the Cigna login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting Cigna scraper...");

    const formData = new FormData();
    formData.append("portalId", "cigna");
    formData.append("credentialExcel", cignaCredentialFile);
    formData.append("inputExcel", cignaInputFile);
    formData.append("loginFileName", cignaCredentialFile.name);
    formData.append("claimFileName", cignaInputFile.name);

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
        setCignaOtpRequest({
          inputName: eventData.inputName,
          label: eventData.label || "Cigna verification code",
          message: eventData.message || "Enter the 6-digit Cigna email verification code.",
        });
        setCignaOtpValue("");
        setStatus(eventData.message || "Waiting for Cigna verification code.");
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
      setCignaJobId(jobId);
      setActiveJobId(jobId);
      setCignaCredentialFile(null);
      setCignaInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Cigna stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        wasCancelled
          ? "Cigna processing cancelled."
          : hasError
            ? `Cigna processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
            : "Cigna processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Cigna claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitCignaOtp() {
    if (!cignaJobId || !cignaOtpRequest || !cignaOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: cignaJobId,
        inputName: cignaOtpRequest.inputName,
        value: cignaOtpValue.trim(),
      });
      setCignaOtpRequest(null);
      setCignaOtpValue("");
      setStatus("Cigna verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit Cigna OTP: ${getErrorMessage(error)}`);
    }
  }

  async function submitMyFamily(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!myFamilyCredentialFile || !myFamilyInputFile) {
      setStatus("Please provide both the My family login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting My family scraper...");

    const formData = new FormData();
    formData.append("portalId", "my-family");
    formData.append("credentialExcel", myFamilyCredentialFile);
    formData.append("inputExcel", myFamilyInputFile);
    formData.append("loginFileName", myFamilyCredentialFile.name);
    formData.append("claimFileName", myFamilyInputFile.name);

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
      setMyFamilyCredentialFile(null);
      setMyFamilyInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("My family stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        wasCancelled
          ? "My family processing cancelled."
          : hasError
            ? `My family processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
            : "My family processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process My family claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  async function submitPhysicians(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!physiciansCredentialFile || !physiciansInputFile) {
      setStatus("Please provide both the Physicians login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting Physicians scraper...");

    const formData = new FormData();
    formData.append("portalId", "physicians");
    formData.append("credentialExcel", physiciansCredentialFile);
    formData.append("inputExcel", physiciansInputFile);
    formData.append("loginFileName", physiciansCredentialFile.name);
    formData.append("claimFileName", physiciansInputFile.name);

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
      setPhysiciansCredentialFile(null);
      setPhysiciansInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: handleJobEvent,
        onStreamError(error) {
          console.error("Physicians stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        wasCancelled
          ? "Physicians processing cancelled."
          : hasError
            ? `Physicians processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
            : "Physicians processing completed.",
      );
    } catch (error) {
      setStatus(`Failed to process Physicians claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }



  async function submitAstrona(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const isAllCare = effectivePortalId === "all-care";
    const credentialFile = isAllCare ? allCareCredentialFile : astronaCredentialFile;
    const inputFile = isAllCare ? allCareInputFile : astronaInputFile;
    const portalId = isAllCare ? "all-care" : "astrona";
    const portalName = isAllCare ? "All Care" : "Astrona";
    if (!credentialFile || !inputFile) {
      setStatus(`Please provide both the ${portalName} login Excel and claim Excel files.`);
      return;
    }

    resetRunState(`Starting ${portalName} scraper...`);
    const formData = new FormData();
    formData.append("portalId", portalId);
    formData.append("credentialExcel", credentialFile);
    formData.append("inputExcel", inputFile);
    formData.append("loginFileName", credentialFile.name);
    formData.append("claimFileName", inputFile.name);
    let hasError = false;
    let wasCancelled = false;
    let finalErrorMessage = "";
    let subscribedJobId = "";
    const streamAbortController = new AbortController();

    try {
      const jobId = await startScrapeJob(formData);
      subscribedJobId = jobId;
      setActiveJobId(jobId);
      if (isAllCare) {
        setAllCareCredentialFile(null);
        setAllCareInputFile(null);
      } else {
        setAstronaCredentialFile(null);
        setAstronaInputFile(null);
      }
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          if (eventData.type === "log" && eventData.message) {
            setLogs((prev) => [...prev, eventData.message ?? ""]);
            setStatus(eventData.message);
          }
          else if (eventData.type === "progress" && typeof eventData.completed === "number" && typeof eventData.total === "number") setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
          else if (eventData.type === "astrona_result" && eventData.rows?.length) setAstronaResults((previous) => [...previous, ...(eventData.rows ?? [])]);
          else if (eventData.type === "error_screenshot" && typeof eventData.index === "number" && eventData.image) setErrorScreenshots((prev) => [...prev, { index: eventData.index ?? -1, image: eventData.image ?? "" }]);
          else if (eventData.type === "file_download" && eventData.filename && eventData.base64) {
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
            hasError = true;
            finalErrorMessage = eventData.message;
            setLogs((prev) => [...prev, `ERROR: ${eventData.message}`]);
          } else if (eventData.type === "cancelled") wasCancelled = true;
        },
        onStreamError(error) {
          hasError = true;
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
        },
      });
      setStatus(wasCancelled ? `${portalName} processing cancelled.` : hasError ? `${portalName} processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}` : `${portalName} processing completed.`);
    } catch (error) {
      setStatus(`Failed to process ${portalName} claims: ${getErrorMessage(error)}`);
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
    }
  }

  function submitAllCare(e: FormEvent<HTMLFormElement>) {
    void submitAstrona(e);
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
      setStatus("Replacing previous Blue Shield run and starting a new one...");
      try {
        await cancelScrapeJobRequest(activeBlueShieldJob.jobId);
      } catch (error) {
        setStatus(`Failed to replace previous Blue Shield run: ${getErrorMessage(error)}`);
        return;
      }
    }

    setPendingBlueShieldRestoreJob(null);
    resetRunState(activeBlueShieldJob ? "Starting new Blue Shield scraper..." : "Starting Blue Shield scraper...");

    const formData = new FormData();
    formData.append("portalId", "blue-shield");
    formData.append("credentialExcel", blueShieldCredentialFile);
    formData.append("inputExcel", blueShieldInputFile);
    formData.append("loginFileName", blueShieldCredentialFile.name);
    formData.append("claimFileName", blueShieldInputFile.name);
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
        setProgress({ completed: eventData.completed, total: eventData.total, currentRow: eventData.currentRow });
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
      setBlueShieldCredentialFile(null);
      setBlueShieldInputFile(null);
      void refreshWorkflowRuns({ silent: true });
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
        setStatus("A previous Blue Shield run is still active. Use the active-runs table to view or cancel that specific run.");
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
      setRegalLoginFile(null);
      setRegalClaimFile(null);
      void refreshWorkflowRuns({ silent: true });
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

  async function submitOptumPro(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!optumProLoginFile || !optumProInputFile) {
      setStatus("Please provide both the Optum Pro login Excel and claim Excel files.");
      return;
    }

    resetRunState("Starting Optum Pro processing...");
    setOptumProStopping(false);
    setOptumProStaleRunAvailable(false);

    const formData = new FormData();
    formData.append("portalId", "optum-pro");
    formData.append("loginExcel", optumProLoginFile);
    formData.append("inputExcel", optumProInputFile);
    formData.append("loginFileName", optumProLoginFile.name);
    formData.append("claimFileName", optumProInputFile.name);

    let hasError = false;
    let finalErrorMessage = "";
    const streamAbortController = new AbortController();

    try {
      const jobId = await startScrapeJob(formData);
      setOptumProJobId(jobId);
      setActiveJobId(jobId);
      setOptumProLoginFile(null);
      setOptumProInputFile(null);
      void refreshWorkflowRuns({ silent: true });
      await subscribeToScrapeJobEvents({
        jobId,
        signal: streamAbortController.signal,
        onEvent: async (eventData) => {
          await handleOptumProJobEvent(eventData, jobId, (message) => {
            finalErrorMessage = message;
            hasError = true;
          });
        },
        onStreamError(error) {
          console.error("Optum Pro stream error:", error);
          finalErrorMessage = getErrorMessage(error);
          setLogs((prev) => [...prev, `STREAM ERROR: ${finalErrorMessage}`]);
          setStatus(`Stream error: ${finalErrorMessage}`);
          hasError = true;
        },
      });
      setStatus(
        hasError
          ? `Optum Pro processing finished with errors${finalErrorMessage ? `: ${finalErrorMessage}` : "."}`
          : "Optum Pro processing completed.",
      );
    } catch (error) {
      const existingJobId = getActiveScrapeJobErrorId(error);
      if (existingJobId) {
        setOptumProJobId(existingJobId);
        setOptumProStaleRunAvailable(true);
        setStatus(`Failed to process Optum Pro claims: ${getErrorMessage(error)} Use Stop Optum Pro scraping to cancel that active run.`);
      } else {
        setStatus(`Failed to process Optum Pro claims: ${getErrorMessage(error)}`);
      }
    } finally {
      setIsProcessing(false);
      setActiveJobId("");
      setOptumProStopping(false);
    }
  }

  async function stopOptumPro() {
    if (!optumProJobId || optumProStopping) return;

    setOptumProStopping(true);
    setStatus("Stopping Optum Pro scraping...");
    try {
      await cancelScrapeJobRequest(optumProJobId);
      setOptumProStaleRunAvailable(false);
      setOptumProOtpRequest(null);
      setOptumProOtpValue("");
      setStatus("Stop requested for Optum Pro scraping.");
    } catch (error) {
      setOptumProStopping(false);
      setStatus(`Failed to stop Optum Pro scraping: ${getErrorMessage(error)}`);
    }
  }

  async function submitOptumProOtp() {
    if (!optumProJobId || !optumProOtpRequest || !optumProOtpValue.trim()) return;

    try {
      await submitScrapeJobInput({
        jobId: optumProJobId,
        inputName: optumProOtpRequest.inputName,
        value: optumProOtpValue.trim(),
      });
      setOptumProOtpRequest(null);
      setOptumProOtpValue("");
      setStatus("Optum Pro verification code submitted.");
    } catch (error) {
      setStatus(`Failed to submit Optum Pro OTP: ${getErrorMessage(error)}`);
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

  async function downloadLatestAvailityOutput() {
    let output = latestAvailityOutput;
    const currentJob = await getCurrentScrapeJob().catch(() => null);
    const latestSnapshot = [...(currentJob?.artifacts ?? [])]
      .reverse()
      .find((artifact) => artifact.artifactType === "output_snapshot" && artifact.contentBase64 && artifact.filename);
    if (latestSnapshot?.contentBase64 && latestSnapshot.filename) {
      output = {
        filename: latestSnapshot.filename,
        base64: latestSnapshot.contentBase64,
        mimeType: latestSnapshot.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        completed: currentJob?.currentCompleted,
        total: currentJob?.totalRows,
      };
      setLatestAvailityOutput(output);
    }

    if (!output) {
      setStatus("No Availity current-results workbook is available yet. Try again after the first row completes.");
      return;
    }

    const completedSuffix = typeof output.completed === "number" && typeof output.total === "number"
      ? `-${output.completed}-of-${output.total}`
      : "";
    const filename = output.filename === "availity_output_snapshot.xlsx"
      ? `availity_claimstatus_partial${completedSuffix}.xlsx`
      : output.filename;
    downloadBase64File(filename, output.base64, output.mimeType);
    setStatus(`Downloaded ${filename}`);
  }

  const workflowRunsPanel = workflowRunTrackingEnabled ? (
    <div className="mt-5 rounded-[1.5rem] border border-sky-200 bg-gradient-to-br from-white via-white to-sky-50/70 p-5 shadow-[0_18px_42px_rgba(14,116,144,0.10)] ring-1 ring-sky-100/70">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-sky-600">My Active Runs</p>
          <h2 className="mt-1 text-base font-semibold text-slate-950">Current automation progress</h2>
          <p className="mt-1 text-xs text-slate-500">
            {runningWorkflowRunCount} active {runningWorkflowRunCount === 1 ? "run" : "runs"} across your account.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshWorkflowRuns()}
          className="inline-flex h-10 items-center justify-center rounded-[0.95rem] border border-sky-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-sky-50"
        >
          {workflowRunsLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {workflowRunsError ? (
        <div className="rounded-[1rem] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load runs: {workflowRunsError}
        </div>
      ) : visibleWorkflowRuns.length === 0 ? (
        <div className="rounded-[1rem] border border-dashed border-sky-300 bg-sky-50/80 px-4 py-6 text-center text-sm text-slate-500">
          No active runs found for this view.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-sky-200 bg-sky-50/70 text-xs uppercase tracking-[0.14em] text-slate-500">
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Run</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Workflow</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Portal</th>
                <th className="min-w-[14rem] px-3 py-3 font-semibold">Uploaded File</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Status</th>
                <th className="min-w-[12rem] px-3 py-3 font-semibold">Progress</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Created</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Updated</th>
                <th className="whitespace-nowrap px-3 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleWorkflowRuns.map((job) => {
                const portalName = claimStatusPortalRegistry.find((portal) => portal.id === job.portalId)?.name ?? job.portalId.toUpperCase();
                const progressPercent = job.totalRows > 0
                  ? Math.min(100, Math.round((job.currentCompleted / job.totalRows) * 100))
                  : 0;
                const isActiveStatus = isLiveWorkflowStatus(job.status);
                const hasOutput = hasExcelOutput(job);
                const statusClassName =
                  job.status === "completed"
                    ? "bg-emerald-50 text-emerald-700"
                    : job.status === "failed"
                      ? "bg-red-50 text-red-700"
                      : job.status === "cancelled"
                        ? "bg-slate-100 text-slate-600"
                        : job.status === "waiting_otp"
                          ? "bg-amber-50 text-amber-700"
                          : "bg-blue-50 text-blue-700";

                return (
                  <tr
                    key={job.jobId}
                    className={`border-b border-sky-100 last:border-0 ${selectedWorkflowRunId === job.jobId ? "bg-blue-50/65" : "hover:bg-sky-50/45"}`}
                  >
                    <td className="whitespace-nowrap px-3 py-3">
                      <button
                        type="button"
                        onClick={() => void selectWorkflowRun(job)}
                        className="font-mono text-xs font-semibold text-blue-700 hover:text-blue-900"
                      >
                        {formatShortJobId(job.jobId)}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{formatWorkflowLabel(job.workflowId)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{portalName}</td>
                    <td className="px-3 py-3">
                      <div className="max-w-[18rem] truncate text-xs text-slate-500" title={formatUploadedJobFiles(job)}>
                        {formatUploadedJobFiles(job)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClassName}`}>
                        {job.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span>{job.totalRows > 0 ? `${job.currentCompleted} of ${job.totalRows} rows` : "Rows not reported"}</span>
                        <span>{progressPercent}%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-sky-50">
                        <div
                          className={`h-full rounded-full ${job.status === "failed" ? "bg-red-400" : job.status === "completed" ? "bg-emerald-500" : "bg-blue-500"}`}
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.updatedAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void selectWorkflowRun(job)}
                          className="rounded-[0.75rem] border border-sky-100 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-sky-50"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => void downloadWorkflowRun(job)}
                          disabled={!hasOutput || downloadingWorkflowJobId === job.jobId}
                          title={hasOutput ? "Download the latest partial output workbook" : "No partial output workbook has been saved yet"}
                          className="rounded-[0.75rem] border border-emerald-100 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          {downloadingWorkflowJobId === job.jobId ? "Preparing" : hasOutput ? "Partial" : "No partial"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancelWorkflowRun(job)}
                          disabled={!isActiveStatus || cancellingWorkflowJobId === job.jobId}
                          className="rounded-[0.75rem] border border-red-100 bg-white px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          {cancellingWorkflowJobId === job.jobId ? "Cancelling" : "Cancel"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  ) : null;

  const operationsRunningJobsPanel = canViewOperationsRunningJobs ? (
    <div className="mt-5 rounded-[1.5rem] border border-indigo-100 bg-white/92 p-5 shadow-[0_16px_36px_rgba(148,163,184,0.12)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-indigo-600">Operations</p>
          <h2 className="mt-1 text-base font-semibold text-slate-950">All running tasks</h2>
          <p className="mt-1 text-xs text-slate-500">
            {operationsRunningJobs.length} active {operationsRunningJobs.length === 1 ? "task" : "tasks"} across users.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshOperationsRunningJobs()}
          className="inline-flex h-10 items-center justify-center rounded-[0.95rem] border border-indigo-100 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-indigo-50"
        >
          {operationsRunningJobsLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {operationsRunningJobsError ? (
        <div className="rounded-[1rem] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load running tasks: {operationsRunningJobsError}
        </div>
      ) : operationsRunningJobs.length === 0 ? (
        <div className="rounded-[1rem] border border-dashed border-indigo-200 bg-indigo-50/60 px-4 py-6 text-center text-sm text-slate-500">
          No running tasks found.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-indigo-100 text-xs uppercase tracking-[0.14em] text-slate-400">
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Run</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">User</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Workflow</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Portal</th>
                <th className="min-w-[14rem] px-3 py-3 font-semibold">Uploaded File</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Status</th>
                <th className="min-w-[12rem] px-3 py-3 font-semibold">Progress</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Created</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Updated</th>
                <th className="whitespace-nowrap px-3 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {operationsRunningJobs.map((job) => {
                const portalName = claimStatusPortalRegistry.find((portal) => portal.id === job.portalId)?.name ?? job.portalId.toUpperCase();
                const progressPercent = job.totalRows > 0
                  ? Math.min(100, Math.round((job.currentCompleted / job.totalRows) * 100))
                  : 0;
                const isActiveStatus = isLiveWorkflowStatus(job.status);

                return (
                  <tr
                    key={job.jobId}
                    className={`border-b border-indigo-50 last:border-0 ${selectedWorkflowRunId === job.jobId ? "bg-indigo-50/45" : ""}`}
                  >
                    <td className="whitespace-nowrap px-3 py-3">
                      <button
                        type="button"
                        onClick={() => void selectWorkflowRun(job)}
                        className="font-mono text-xs font-semibold text-blue-700 hover:text-blue-900"
                      >
                        {formatShortJobId(job.jobId)}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <div className="max-w-[12rem] truncate text-xs text-slate-600" title={job.createdByEmail || job.userId || "unknown"}>
                        {job.createdByName && job.createdByName !== "unknown" ? job.createdByName : job.createdByEmail || job.userId || "unknown"}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{formatWorkflowLabel(job.workflowId)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{portalName}</td>
                    <td className="px-3 py-3">
                      <div className="max-w-[18rem] truncate text-xs text-slate-500" title={formatUploadedJobFiles(job)}>
                        {formatUploadedJobFiles(job)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                        {job.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span>{job.totalRows > 0 ? `${job.currentCompleted} of ${job.totalRows} rows` : "Rows not reported"}</span>
                        <span>{progressPercent}%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-indigo-50">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${progressPercent}%` }} />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.updatedAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void selectWorkflowRun(job)}
                          className="rounded-[0.75rem] border border-indigo-100 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-indigo-50"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancelWorkflowRun(job)}
                          disabled={!isActiveStatus || cancellingWorkflowJobId === job.jobId}
                          className="rounded-[0.75rem] border border-red-100 bg-white px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          {cancellingWorkflowJobId === job.jobId ? "Cancelling" : "Cancel"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void forceStopWorkflowRun(job)}
                          disabled={!isActiveStatus || forceStoppingWorkflowJobId === job.jobId}
                          className="rounded-[0.75rem] border border-amber-100 bg-white px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          {forceStoppingWorkflowJobId === job.jobId ? "Stopping" : "Force Stop"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  ) : null;

  const outputsPanel = workflowRunTrackingEnabled ? (
    <div className="mx-auto w-full max-w-5xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-emerald-600">Outputs</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">Excel output files</h1>
          <p className="mt-1 text-sm text-slate-600">
            Completed workbooks remain available here after the browser is closed because downloads are created from S3.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshWorkflowRuns()}
          className="inline-flex h-10 items-center justify-center rounded-[0.95rem] border border-emerald-100 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-emerald-50"
        >
          {workflowRunsLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {workflowRunsError ? (
        <div className="mt-5 rounded-[1rem] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load outputs: {workflowRunsError}
        </div>
      ) : outputWorkflowRuns.length === 0 ? (
        <div className="mt-5 rounded-[1rem] border border-dashed border-emerald-200 bg-emerald-50/60 px-4 py-8 text-center text-sm text-slate-500">
          No Excel outputs are available yet.
        </div>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-emerald-100 text-xs uppercase tracking-[0.14em] text-slate-400">
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Output</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Workflow</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Portal</th>
                <th className="min-w-[14rem] px-3 py-3 font-semibold">Source File</th>
                <th className="min-w-[10rem] px-3 py-3 font-semibold">Created By</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Status</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">Created</th>
                <th className="whitespace-nowrap px-3 py-3 font-semibold">End Time</th>
                <th className="whitespace-nowrap px-3 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {outputWorkflowRuns.map((job) => {
                const portalName = claimStatusPortalRegistry.find((portal) => portal.id === job.portalId)?.name ?? job.portalId.toUpperCase();
                const outputArtifact = (job.artifacts ?? []).find(isExcelOutputArtifact);
                const creator = job.createdByName && job.createdByName !== "unknown"
                  ? job.createdByName
                  : job.createdByEmail || job.userId || "unknown";
                const statusClassName =
                  job.status === "completed"
                    ? "bg-emerald-50 text-emerald-700"
                    : job.status === "failed"
                      ? "bg-red-50 text-red-700"
                      : job.status === "cancelled"
                        ? "bg-slate-100 text-slate-600"
                        : "bg-blue-50 text-blue-700";

                return (
                  <tr key={job.jobId} className="border-b border-emerald-50 last:border-0 hover:bg-emerald-50/35">
                    <td className="px-3 py-3">
                      <div className="flex min-w-[12rem] items-center gap-2">
                        <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-600" strokeWidth={2} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-800" title={outputArtifact?.filename || "Output workbook"}>
                            {outputArtifact?.filename || "Output workbook"}
                          </div>
                          <div className="font-mono text-[0.7rem] text-slate-400">{formatShortJobId(job.jobId)}</div>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{formatWorkflowLabel(job.workflowId)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">{portalName}</td>
                    <td className="px-3 py-3">
                      <div className="max-w-[18rem] truncate text-xs text-slate-500" title={formatUploadedJobFiles(job)}>
                        {formatUploadedJobFiles(job)}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="max-w-[12rem] truncate text-xs text-slate-600" title={job.createdByEmail || creator}>
                        {creator}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClassName}`}>
                        {job.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatRunTimestamp(job.finishedAt || job.updatedAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => void downloadWorkflowRun(job)}
                          disabled={downloadingWorkflowJobId === job.jobId}
                          className="inline-flex items-center gap-2 rounded-[0.75rem] border border-emerald-100 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          <Download className="h-3.5 w-3.5" strokeWidth={2.1} />
                          {downloadingWorkflowJobId === job.jobId ? "Preparing" : "Download"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  ) : null;

  if (authLoading && !authUser) {
    return null;
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
                src="/opus-logo-2.jpg"
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

          <button
            type="button"
            onClick={() => {
              if (effectivePortalId) {
                resetPortalSelection();
              } else {
                router.push("/portal");
              }
            }}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>
      </nav>

      <div className="mx-auto w-full max-w-[96rem] px-3 py-8 sm:px-4 xl:px-5">
        <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="hidden rounded-[2rem] border border-sky-100 bg-white/82 p-4 shadow-[0_18px_60px_rgba(148,163,184,0.14)] backdrop-blur-xl xl:flex xl:min-h-[calc(100vh-10rem)] xl:flex-col 2xl:p-5">
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
                onClick={() => {
                  setActiveView("portal-selection");
                  router.push("/portal");
                }}
                className={`flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium transition ${
                  activeView === "portal-selection"
                    ? "bg-[linear-gradient(90deg,rgba(37,99,235,0.12)_0%,rgba(37,99,235,0.04)_100%)] text-blue-700"
                    : "text-slate-600 hover:bg-sky-50 hover:text-slate-900"
                }`}
              >
                <LayoutDashboard className="h-4 w-4" strokeWidth={2} />
                Dashboard
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveView("outputs");
                  void refreshWorkflowRuns();
                }}
                className={`flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium transition ${
                  activeView === "outputs"
                    ? "bg-[linear-gradient(90deg,rgba(16,185,129,0.13)_0%,rgba(16,185,129,0.04)_100%)] text-emerald-700"
                    : "text-slate-600 hover:bg-sky-50 hover:text-slate-900"
                }`}
              >
                <FileSpreadsheet className="h-4 w-4" strokeWidth={2} />
                Outputs
              </button>
              {effectivePortalId && !authUser.mustResetPassword ? (
                <button
                  type="button"
                  disabled={blockPortalFormForProcessing}
                  onClick={resetPortalSelection}
                  className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  <Activity className="h-4 w-4" strokeWidth={2} />
                  Change Portal
                </button>
              ) : null}
              <button
                type="button"
                onClick={openResetPassword}
                className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900"
              >
                <ShieldEllipsis className="h-4 w-4" strokeWidth={2} />
                Reset Password
              </button>
              {hasFullWorkflowAccess(authUser) && (
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
                disabled={blockPortalFormForProcessing}
                className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-sky-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400"
              >
                <LogOut className="h-4 w-4" strokeWidth={2} />
                Logout
              </button>
            </nav>

          </aside>

          <div className="min-w-0">
        {activeView === "outputs" ? (
          outputsPanel
        ) : activeView === "reset-password" ? (
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
        ) : activeView === "manage-users" && hasFullWorkflowAccess(authUser) ? (
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
                      <p className="text-[0.7rem] text-slate-500">{formatUserRole(authUser.role)}</p>
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
                    Welcome Back, <span className="text-[#2563EB]">{userDisplayName || "Afrin"}</span> ðŸ‘‹
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

              {workflowRunsPanel}
              {operationsRunningJobsPanel}

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
                  <div className={portalLayout === "grid" ? "grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" : "space-y-4"}>
                    {filteredPortals.map((portal) => {
                      const meta = PORTAL_UI_META[portal.id as PortalId];

                      return (
                        <button
                          key={portal.id}
                          type="button"
                          onClick={() => {
                            navigateToPortalRoute(portal.id as PortalId);
                            setStatus("");
                            setLogs([]);
                            setErrorScreenshots([]);
                            setProgress(null);
    setAstronaResults([]);
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
                className="relative overflow-hidden rounded-[1.6rem] border border-sky-100 bg-[linear-gradient(135deg,rgba(239,246,255,0.96)_0%,rgba(221,235,255,0.84)_55%,rgba(255,255,255,0.96)_100%)] p-5 shadow-[0_18px_40px_rgba(148,163,184,0.12)]"
              >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-center">
                  <div className="max-w-xl">
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={`flex items-center justify-center overflow-hidden text-sm font-semibold shadow-inner ${
                          selectedPortalUiMeta?.logoSrc
                            ? (selectedPortalUiMeta.heroLogoFrameClassName ?? "h-12 w-[5.6rem] rounded-[1rem] px-2.5")
                            : "h-12 w-12 rounded-[1rem]"
                        } ${selectedPortalUiMeta?.logoClassName ?? "bg-blue-50 text-blue-700"}`}
                      >
                        {selectedPortalUiMeta?.logoSrc ? (
                          <Image
                            src={selectedPortalUiMeta.logoSrc}
                            alt={`${selectedPortal.name} logo`}
                            width={selectedPortalUiMeta.heroLogoSize?.width ?? 84}
                            height={selectedPortalUiMeta.heroLogoSize?.height ?? 28}
                            className={selectedPortalUiMeta.heroLogoImageClassName ?? "h-6 w-full object-contain"}
                          />
                        ) : (
                          selectedPortalUiMeta?.shortCode ?? "PRT"
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[0.72rem] font-semibold text-emerald-600">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Ready
                      </span>
                    </div>
                    <h1 className="mt-4 text-[1.8rem] font-semibold tracking-[-0.05em] text-slate-950">{selectedPortal.name}</h1>
                  </div>

                  <div className="relative hidden h-[12rem] overflow-hidden rounded-[1.2rem] border border-sky-100/80 bg-white/55 shadow-[0_14px_28px_rgba(59,130,246,0.1)] lg:block">
                    <Image
                      src={dashboardWelcomeImage}
                      alt="Healthcare workflow illustration"
                      fill
                      className="object-cover object-center opacity-100 scale-[0.92]"
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

              {workflowRunsPanel}

              <div className="mt-5">
                <div className="rounded-[1.7rem] border border-indigo-200 bg-gradient-to-br from-white via-white to-indigo-50/60 p-5 shadow-[0_18px_42px_rgba(79,70,229,0.10)] ring-1 ring-indigo-100/70">
                  <div className="mb-5 border-b border-indigo-100 pb-4">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-indigo-600">Portal Workflow</p>
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
                      isProcessing={blockPortalFormForProcessing}
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
                      isProcessing={blockPortalFormForProcessing}
                      selectedSubportal={aerialSubportal}
                      onCredentialFileChange={setAerialCredentialFile}
                      onInputFileChange={setAerialInputFile}
                      onSubportalChange={setAerialSubportal}
                      onSubmit={submitAerial}
                    />
                  ) : effectivePortalId === "regal" ? (
                    <RegalInputForm
                      canSubmit={canSubmitRegal}
                      claimFileName={regalClaimFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
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
                      isProcessing={blockPortalFormForProcessing}
                      selectedProjectId={availityProjectId}
                      onCredentialFileChange={setAvailityCredentialFile}
                      onInputFileChange={setAvailityInputFile}
                      onProjectChange={setAvailityProjectId}
                      onSubmit={submitAvaility}
                    />
                  ) : effectivePortalId === "uhc" ? (
                    <UhcInputForm
                      browserType={uhcBrowserType}
                      canSubmit={canSubmitUhc}
                      claimFileName={uhcClaimFileName}
                      groupId={uhcGroupId}
                      isProcessing={blockPortalFormForProcessing}
                      loginFileName={uhcLoginFile?.name ?? ""}
                      onBrowserTypeChange={setUhcBrowserType}
                      onClaimFileSelect={selectUhcClaimFile}
                      onGroupChange={setUhcGroupId}
                      onLoginFileChange={setUhcLoginFile}
                      onSubmit={submitUhc}
                    />
                  ) : effectivePortalId === "astrona" ? (
                    <AstronaInputForm
                      canSubmit={canSubmitAstrona}
                      credentialFileName={astronaCredentialFile?.name ?? ""}
                      inputFileName={astronaInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setAstronaCredentialFile}
                      onInputFileChange={setAstronaInputFile}
                      onSubmit={submitAstrona}
                    />
                  ) : effectivePortalId === "all-care" ? (
                    <AllCareInputForm
                      canSubmit={canSubmitAllCare}
                      credentialFileName={allCareCredentialFile?.name ?? ""}
                      inputFileName={allCareInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setAllCareCredentialFile}
                      onInputFileChange={setAllCareInputFile}
                      onSubmit={submitAllCare}
                    />
                  ) : effectivePortalId === "cigna" ? (
                    <CignaInputForm
                      canSubmit={canSubmitCigna}
                      credentialFileName={cignaCredentialFile?.name ?? ""}
                      inputFileName={cignaInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setCignaCredentialFile}
                      onInputFileChange={setCignaInputFile}
                      onSubmit={submitCigna}
                    />
                  ) : effectivePortalId === "kaiser" ? (
                    <KaiserInputForm
                      canSubmit={canSubmitKaiser}
                      credentialFileName={kaiserCredentialFile?.name ?? ""}
                      inputFileName={kaiserInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setKaiserCredentialFile}
                      onInputFileChange={setKaiserInputFile}
                      onSubmit={submitKaiser}
                    />
                  ) : effectivePortalId === "my-family" ? (
                    <MyFamilyInputForm
                      canSubmit={canSubmitMyFamily}
                      credentialFileName={myFamilyCredentialFile?.name ?? ""}
                      inputFileName={myFamilyInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setMyFamilyCredentialFile}
                      onInputFileChange={setMyFamilyInputFile}
                      onSubmit={submitMyFamily}
                    />
                  ) : effectivePortalId === "physicians" ? (
                    <PhysiciansInputForm
                      canSubmit={canSubmitPhysicians}
                      credentialFileName={physiciansCredentialFile?.name ?? ""}
                      inputFileName={physiciansInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setPhysiciansCredentialFile}
                      onInputFileChange={setPhysiciansInputFile}
                      onSubmit={submitPhysicians}
                    />
                  ) : effectivePortalId === "optum-pro" ? (
                    <OptumProInputForm
                      canSubmit={canSubmitOptumPro}
                      inputFileName={optumProInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      loginFileName={optumProLoginFile?.name ?? ""}
                      onInputFileChange={setOptumProInputFile}
                      onLoginFileChange={setOptumProLoginFile}
                      onSubmit={submitOptumPro}
                    />
                  ) : effectivePortalId === "waystar" ? (
                    <WaystarInputForm
                      canSubmit={canSubmitWaystar}
                      inputFileName={waystarInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      loginFileName={waystarLoginFile?.name ?? ""}
                      onInputFileChange={setWaystarInputFile}
                      onLoginFileChange={setWaystarLoginFile}
                      onSubmit={submitWaystar}
                    />
                  ) : (
                    <BlueShieldInputForm
                      canSubmit={canSubmitBlueShield}
                      credentialFileName={blueShieldCredentialFile?.name ?? ""}
                      inputFileName={blueShieldInputFile?.name ?? ""}
                      isProcessing={blockPortalFormForProcessing}
                      onCredentialFileChange={setBlueShieldCredentialFile}
                      onInputFileChange={setBlueShieldInputFile}
                      onSubmit={submitBlueShield}
                    />
                  )}
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
                    outputCompleted={latestRegalOutput?.completed}
                    outputTotal={latestRegalOutput?.total}
                    progress={progress}
                    status={status}
                  />
                </div>
              ) : effectivePortalId === "availity" ? (
                <div className="mt-5">
                  <AvailityResultView
                    canDownloadOutput={Boolean(latestAvailityOutput || activeJobId || availityJobId)}
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    onOutputDownload={downloadLatestAvailityOutput}
                    onOtpChange={setAvailityOtpValue}
                    onOtpSubmit={submitAvailityOtp}
                    outputCompleted={latestAvailityOutput?.completed}
                    outputTotal={latestAvailityOutput?.total}
                    otpRequest={availityOtpRequest}
                    otpValue={availityOtpValue}
                    progress={progress}
                    status={status}
                  />
                </div>
              ) : effectivePortalId === "waystar" ? (
                <div className="mt-5">
                  <WaystarResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
              ) : effectivePortalId === "uhc" ? (
                <div className="mt-5">
                  <UhcResultView
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    onOtpChange={setUhcOtpValue}
                    onOtpSubmit={submitUhcOtp}
                    onProviderChange={(value) => setUhcProviderPrompt((current) => current ? { ...current, value } : current)}
                    onProviderSubmit={submitUhcProviderSelection}
                    otpRequest={uhcOtpRequest}
                    otpValue={uhcOtpValue}
                    progress={progress}
                    providerPrompt={uhcProviderPrompt}
                    status={status}
                  />
                </div>
              ) : effectivePortalId === "astrona" ? (
                <div className="mt-5">
                  <AstronaResultView errorScreenshots={errorScreenshots} isProcessing={isProcessing} logs={logs} progress={progress} rows={astronaResults} status={status} />
                </div>
              ) : effectivePortalId === "all-care" ? (
                <div className="mt-5">
                  <AllCareResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
              ) : effectivePortalId === "cigna" ? (
                <div className="mt-5">
                  <CignaResultView
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    onOtpChange={setCignaOtpValue}
                    onOtpSubmit={submitCignaOtp}
                    otpRequest={cignaOtpRequest}
                    otpValue={cignaOtpValue}
                    progress={progress}
                    status={status}
                  />
                </div>
              ) : effectivePortalId === "kaiser" ? (
                <div className="mt-5">
                  <KaiserResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
              ) : effectivePortalId === "my-family" ? (
                <div className="mt-5">
                  <MyFamilyResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
              ) : effectivePortalId === "physicians" ? (
                <div className="mt-5">
                  <PhysiciansResultView errorScreenshots={errorScreenshots} logs={logs} progress={progress} status={status} />
                </div>
              ) : effectivePortalId === "optum-pro" ? (
                <div className="mt-5">
                  <OptumProResultView
                    errorScreenshots={errorScreenshots}
                    logs={logs}
                    canStop={Boolean(optumProJobId && (isProcessing || optumProStaleRunAvailable))}
                    isStopping={optumProStopping}
                    onOtpChange={setOptumProOtpValue}
                    onOtpSubmit={submitOptumProOtp}
                    onStop={stopOptumPro}
                    otpRequest={optumProOtpRequest}
                    otpValue={optumProOtpValue}
                    progress={progress}
                    status={status}
                  />
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
