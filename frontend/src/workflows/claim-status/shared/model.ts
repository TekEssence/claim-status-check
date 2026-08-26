import type { CurrentScrapeJob, ScrapeJobSummary } from "../../../api/scrape-jobs-api";

export type AuthUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "DEVELOPER" | "USER";
  mustResetPassword: boolean;
};

export type ManagedUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "DEVELOPER" | "USER";
  isActive: boolean;
  mustResetPassword: boolean;
};

export type DashboardStatsData = {
  availablePortals: number;
  completedClaimsToday: number;
  failedJobsToday: number;
  portalsRunToday: number;
  runningJobs: number;
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
export type DownloadableArtifact = {
  filename: string;
  base64: string;
  mimeType: string;
  completed?: number;
  total?: number;
};

export const SELECTED_PORTAL_STORAGE_KEY = "iehp-selected-portal";
export const SKIP_JOB_RESTORE_ONCE_KEY = "iehp-skip-job-restore-once";
export const AUTH_USER_STORAGE_KEY = "claim-status-auth-user";
export const DOWNLOADED_ARTIFACTS_PREFIX = "iehp-downloaded-artifacts:";
export const PORTAL_ROUTE_MAP: Record<PortalId, string> = {
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

export function isPortalId(value: string): value is PortalId {
  return value === "iehp" || value === "aerial" || value === "all-care" || value === "astrona" || value === "regal" || value === "blue-shield" || value === "availity" || value === "cigna" || value === "kaiser" || value === "medpoint" || value === "my-family" || value === "optum-pro" || value === "physicians" || value === "uhc" || value === "waystar";
}

export function isTerminalWorkflowStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isLiveWorkflowStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting_otp" || status === "waiting_resume" || status === "cancelling";
}

const WORKFLOW_LABELS: Record<string, string> = {
  "claim-status": "Claim Status",
  "eligibility-verification": "Eligibility",
  "payment-eob-download": "Payment EOB",
  "payment-posting": "Payment Posting",
};

export function formatShortJobId(jobId: string): string {
  return jobId ? jobId.slice(0, 8) : "";
}

export function formatRunTimestamp(value: string | null | undefined): string {
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

export function formatWorkflowLabel(workflowId: string | undefined): string {
  if (!workflowId) return "Claim Status";
  return WORKFLOW_LABELS[workflowId] ?? workflowId;
}

export function formatUploadedJobFiles(job: ScrapeJobSummary): string {
  const files = [job.loginFileName, job.claimFileName]
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  return files.length > 0 ? files.join(", ") : "Uploaded files";
}

export function isExcelOutputArtifact(artifact: CurrentScrapeJob["artifacts"][number]): boolean {
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

export function hasExcelOutput(job: ScrapeJobSummary): boolean {
  return (job.artifacts ?? []).some(isExcelOutputArtifact);
}

export function formatUserRole(role: AuthUser["role"]): string {
  if (role === "ADMIN") return "Administrator";
  if (role === "DEVELOPER") return "Developer";
  return "User";
}

export function hasFullWorkflowAccess(user: AuthUser | null): boolean {
  return user?.role === "ADMIN" || user?.role === "DEVELOPER";
}

export function canRestoreCurrentJob(job: CurrentScrapeJob): job is CurrentScrapeJob & { portalId: PortalId } {
  if (!isPortalId(job.portalId)) return false;
  if (job.status === "running") return true;
  return job.portalId === "iehp" && job.status === "waiting_resume";
}

export function persistCachedAuthUser(user: AuthUser | null) {
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

