import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { ScrapeJobEvent } from "../types/job";
import { getCognitoAccessToken } from "./cognito-auth";

export type ScrapeJobStatus = "queued" | "running" | "waiting_otp" | "waiting_resume" | "cancelling" | "completed" | "failed" | "cancelled";

export type CurrentScrapeJob = {
  jobId: string;
  userId?: string;
  portalId: string;
  status: ScrapeJobStatus;
  currentCompleted: number;
  totalRows: number;
  claimFileName: string;
  loginFileName: string;
  createdByUserId: string;
  createdByEmail: string;
  createdByName: string;
  startedAt: string | null;
  logs: string[];
  artifacts: Array<{
    id: number;
    rowIndex: number | null;
    artifactType: string;
    filename: string;
    mimeType: string;
    pathOrKey: string;
    createdAt: string;
    contentBase64?: string;
    contentText?: string;
  }>;
};

export type ScrapeJobSummary = {
  jobId: string;
  userId?: string;
  workflowId?: string;
  portalId: string;
  status: ScrapeJobStatus;
  currentCompleted: number;
  totalRows: number;
  claimFileName: string;
  loginFileName: string;
  createdByUserId: string;
  createdByEmail: string;
  createdByName: string;
  startedAt: string | null;
  errorMessage: string | null;
  artifactCount: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  artifacts: CurrentScrapeJob["artifacts"];
};

export type ScrapeJobDetails = ScrapeJobSummary & {
  logs: string[];
};

export class ActiveScrapeJobError extends Error {
  jobId: string;

  constructor(message: string, jobId: string) {
    super(message);
    this.name = "ActiveScrapeJobError";
    this.jobId = jobId;
  }
}

export class ScrapeJobAuthError extends Error {
  constructor(message = "Your session expired. Please sign in again.") {
    super(message);
    this.name = "ScrapeJobAuthError";
  }
}

const AWS_API_URL = process.env.NEXT_PUBLIC_WORKFLOW_API_URL?.replace(/\/+$/, "") || "";
const AWS_WS_URL = process.env.NEXT_PUBLIC_WORKFLOW_WS_URL || "";

export function isAwsWorkflowMode(): boolean {
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (isLocalHost && process.env.NEXT_PUBLIC_FORCE_AWS_WORKFLOW !== "true") {
      return false;
    }
    if (!isLocalHost) {
      return true;
    }
  }
  return Boolean(AWS_API_URL);
}

function isAwsMode(): boolean {
  return isAwsWorkflowMode();
}

function authHeaders(): HeadersInit {
  const token = getCognitoAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function requireAwsAuthHeaders(): HeadersInit {
  const headers = authHeaders();
  if (!("Authorization" in headers)) {
    throw new ScrapeJobAuthError();
  }
  return headers;
}

function requireAwsApiUrl(): string {
  if (!AWS_API_URL) {
    throw new Error("AWS workflow API URL is not configured in this frontend build. Rebuild/deploy with NEXT_PUBLIC_WORKFLOW_API_URL.");
  }
  return AWS_API_URL;
}

async function throwForAwsAuthResponse(response: Response): Promise<void> {
  if (response.status === 401 || response.status === 403) {
    throw new ScrapeJobAuthError();
  }
}

function getStringField(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getUploadFiles(formData: FormData) {
  const fields = ["claimExcel", "loginExcel", "inputExcel", "credentialExcel", "inputFile", "credentialFile", "referenceExcel"] as const;
  return fields.flatMap((field) => {
    const value = formData.get(field);
    if (!(value instanceof File) || value.size === 0) return [];
    return [{ field, file: value }];
  });
}

function normalizeJobStatus(status: unknown): ScrapeJobSummary["status"] {
  if (status === "done") return "completed";
  if (status === "error") return "failed";
  if (
    status === "queued" ||
    status === "running" ||
    status === "waiting_otp" ||
    status === "waiting_resume" ||
    status === "cancelling" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return "running";
}

function normalizeJobDetails(job: Partial<ScrapeJobDetails>, logs: string[] = []): ScrapeJobDetails {
  return {
    jobId: String(job.jobId ?? ""),
    portalId: String(job.portalId ?? "iehp"),
    status: normalizeJobStatus(job.status),
    currentCompleted: Number(job.currentCompleted ?? 0),
    totalRows: Number(job.totalRows ?? 0),
    claimFileName: String(job.claimFileName ?? ""),
    loginFileName: String(job.loginFileName ?? ""),
    createdByUserId: String(job.createdByUserId ?? job.userId ?? "unknown"),
    createdByEmail: String(job.createdByEmail ?? "unknown"),
    createdByName: String(job.createdByName ?? "unknown"),
    startedAt: typeof job.startedAt === "string" ? job.startedAt : null,
    errorMessage: typeof job.errorMessage === "string" ? job.errorMessage : null,
    artifactCount: Number(job.artifactCount ?? job.artifacts?.length ?? 0),
    createdAt: String(job.createdAt ?? ""),
    updatedAt: String(job.updatedAt ?? ""),
    finishedAt: typeof job.finishedAt === "string" ? job.finishedAt : null,
    artifacts: job.artifacts ?? [],
    logs,
  };
}

function eventPayloadToLog(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const event = payload as { type?: unknown; message?: unknown; level?: unknown };
  if (typeof event.message === "string" && event.message.trim()) {
    return event.message.trim();
  }
  if (typeof event.type === "string" && event.type.trim()) {
    return event.type.replace(/_/g, " ");
  }
  return "";
}

export function getActiveScrapeJobErrorId(error: unknown): string {
  return error instanceof ActiveScrapeJobError ? error.jobId : "";
}

export async function startScrapeJob(formData: FormData): Promise<string> {
  if (isAwsMode()) {
    return startAwsScrapeJob(formData);
  }

  const response = await fetch("/api/scrape-jobs", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    let body: { error?: string; jobId?: string; stage?: string; portalId?: string } = {};
    try {
      body = rawBody ? JSON.parse(rawBody) as typeof body : {};
    } catch {
      body = {};
    }
    const stageSuffix = body.stage ? ` Stage: ${body.stage}.` : "";
    const portalSuffix = body.portalId ? ` Portal: ${body.portalId}.` : "";
    const serverText = rawBody && !body.error ? ` Server response: ${rawBody.slice(0, 300)}` : "";
    const message = body.error
      ? `${body.error}${portalSuffix}${stageSuffix}`
      : `Failed to start scrape job: ${response.status}.${portalSuffix}${stageSuffix}${serverText}`;
    if (response.status === 409 && body.jobId) {
      throw new ActiveScrapeJobError(message, body.jobId);
    }
    throw new Error(message);
  }

  const body = await response.json() as { jobId?: string };
  if (!body.jobId) {
    throw new Error("Failed to start scrape job: missing jobId.");
  }

  return body.jobId;
}

async function startAwsScrapeJob(formData: FormData): Promise<string> {
  const apiUrl = requireAwsApiUrl();
  const files = getUploadFiles(formData);
  const claimRows = getStringField(formData, "claimRows");
  const fileDescriptors = [
    ...files.map(({ field, file }) => ({
      field,
      filename: file.name || `${field}.xlsx`,
      contentType: file.type || "application/octet-stream",
    })),
    ...(claimRows ? [{ field: "claimRows", filename: "claimRows.json", contentType: "application/json" }] : []),
  ];

  const createResponse = await fetch(`${apiUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...requireAwsAuthHeaders() },
    body: JSON.stringify({
      portalId: getStringField(formData, "portalId") || "iehp",
      workflowId: getStringField(formData, "workflowId") || "claim-status",
      files: fileDescriptors,
      formFields: {
        workflowId: getStringField(formData, "workflowId"),
        payerId: getStringField(formData, "payerId"),
        aerialSubportal: getStringField(formData, "aerialSubportal"),
        totalItems: getStringField(formData, "totalItems"),
        startIndex: getStringField(formData, "startIndex"),
        projectId: getStringField(formData, "projectId"),
        checkpointId: getStringField(formData, "checkpointId"),
        resetCheckpoint: getStringField(formData, "resetCheckpoint"),
        claimFileName: getStringField(formData, "claimFileName"),
        loginFileName: getStringField(formData, "loginFileName"),
      },
    }),
  });
  await throwForAwsAuthResponse(createResponse);
  if (!createResponse.ok) {
    const body = await createResponse.json().catch(() => ({})) as { error?: string; jobId?: string };
    if (createResponse.status === 409 && body.jobId) throw new ActiveScrapeJobError(body.error || "Another job is already active.", body.jobId);
    throw new Error(body.error || `Failed to create AWS job: ${createResponse.status}`);
  }

  const createBody = await createResponse.json() as {
    jobId: string;
    uploads: Array<{ field: string; uploadUrl: string }>;
  };

  for (const upload of createBody.uploads) {
    const file = files.find((candidate) => candidate.field === upload.field)?.file;
    const body = upload.field === "claimRows" ? new Blob([claimRows], { type: "application/json" }) : file;
    if (!body) continue;
    const uploadResponse = await fetch(upload.uploadUrl, {
      method: "PUT",
      body,
    });
    if (!uploadResponse.ok) throw new Error(`Failed to upload ${upload.field}: ${uploadResponse.status}`);
  }

  const confirmResponse = await fetch(`${apiUrl}/jobs/${encodeURIComponent(createBody.jobId)}/confirm`, {
    method: "POST",
    headers: { ...requireAwsAuthHeaders() },
  });
  await throwForAwsAuthResponse(confirmResponse);
  if (!confirmResponse.ok) {
    const body = await confirmResponse.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Failed to start AWS worker: ${confirmResponse.status}`);
  }

  return createBody.jobId;
}

export async function submitScrapeJobInput(options: { jobId: string; inputName: string; value: string }): Promise<void> {
  if (isAwsMode()) {
    const apiUrl = requireAwsApiUrl();
    const response = await fetch(`${apiUrl}/jobs/${encodeURIComponent(options.jobId)}/otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...requireAwsAuthHeaders() },
      body: JSON.stringify({ inputName: options.inputName, otp: options.value, value: options.value }),
    });
    await throwForAwsAuthResponse(response);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error || `Failed to submit job input: ${response.status}`);
    }
    return;
  }

  const response = await fetch("/api/scrape-jobs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Failed to submit job input: ${response.status}`);
  }
}

export async function getCurrentScrapeJob(): Promise<CurrentScrapeJob | null> {
  if (isAwsMode()) return null;

  const response = await fetch("/api/scrape-jobs/current");
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load current scrape job: ${response.status}`);
  }
  const body = await response.json() as { job?: CurrentScrapeJob | null };
  return body.job ?? null;
}

export async function cancelScrapeJob(jobId: string): Promise<void> {
  if (isAwsMode()) {
    const apiUrl = requireAwsApiUrl();
    const response = await fetch(`${apiUrl}/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      headers: { ...requireAwsAuthHeaders() },
    });
    await throwForAwsAuthResponse(response);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Failed to cancel scrape job: ${response.status}`);
    }
    return;
  }

  const response = await fetch(`/api/scrape-jobs?jobId=${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to cancel scrape job: ${response.status}`);
  }
}

export async function forceStopScrapeJob(jobId: string, reason = "Force stop requested from operations console."): Promise<void> {
  if (!isAwsMode()) {
    await cancelScrapeJob(jobId);
    return;
  }

  const apiUrl = requireAwsApiUrl();
  const response = await fetch(`${apiUrl}/jobs/${encodeURIComponent(jobId)}/force-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...requireAwsAuthHeaders() },
    body: JSON.stringify({ reason }),
  });
  await throwForAwsAuthResponse(response);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Failed to force stop scrape job: ${response.status}`);
  }
}

export async function subscribeToScrapeJobEvents(options: {
  jobId: string;
  signal: AbortSignal;
  onEvent: (event: ScrapeJobEvent) => Promise<void> | void;
  onStreamError: (error: unknown) => void;
}): Promise<void> {
  if (isAwsMode()) {
    return subscribeToAwsScrapeJobEvents(options);
  }

  await fetchEventSource(`/api/scrape-jobs?jobId=${encodeURIComponent(options.jobId)}`, {
    openWhenHidden: true,
    signal: options.signal,
    async onmessage(ev) {
      if (ev.data === "" || ev.data.startsWith(":")) return;
      const eventData = JSON.parse(ev.data) as ScrapeJobEvent;
      await options.onEvent(eventData);
    },
    onerror(error) {
      options.onStreamError(error);
      return 2000;
    },
  });
}

export async function listScrapeJobs(limit = 25, options?: { scope?: "mine" | "all-running" }): Promise<ScrapeJobSummary[]> {
  const scope = options?.scope && options.scope !== "mine" ? `&scope=${encodeURIComponent(options.scope)}` : "";
  if (!isAwsMode()) {
    const response = await fetch(`/api/scrape-jobs/list?limit=${encodeURIComponent(String(limit))}${scope}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `Failed to load jobs: ${response.status}`);
    }

    const body = await response.json() as { jobs?: ScrapeJobSummary[] };
    return body.jobs ?? [];
  }

  const apiUrl = requireAwsApiUrl();
  const response = await fetch(`${apiUrl}/jobs?limit=${encodeURIComponent(String(limit))}${scope}`, {
    headers: { ...requireAwsAuthHeaders() },
  });
  await throwForAwsAuthResponse(response);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Failed to load jobs: ${response.status}`);
  }

  const body = await response.json() as { jobs?: ScrapeJobSummary[] };
  return body.jobs ?? [];
}

export async function getScrapeJobDetails(jobId: string): Promise<ScrapeJobDetails> {
  if (!isAwsMode()) {
    const response = await fetch(`/api/scrape-jobs/detail?jobId=${encodeURIComponent(jobId)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `Failed to load scrape job: ${response.status}`);
    }

    const body = await response.json() as { job?: Partial<ScrapeJobDetails> };
    return normalizeJobDetails(body.job ?? {}, body.job?.logs ?? []);
  }

  const apiUrl = requireAwsApiUrl();
  const response = await fetch(`${apiUrl}/jobs/${encodeURIComponent(jobId)}?includeLogs=true`, {
    headers: { ...requireAwsAuthHeaders() },
  });
  await throwForAwsAuthResponse(response);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Failed to load scrape job: ${response.status}`);
  }

  const body = await response.json() as {
    job?: Partial<ScrapeJobDetails>;
    events?: Array<{ payload?: unknown }>;
    artifacts?: CurrentScrapeJob["artifacts"];
    logs?: string[];
  };
  const eventLogs = (body.events ?? [])
    .map((event) => eventPayloadToLog(event.payload))
    .filter(Boolean);
  const logs = body.logs && body.logs.length > 0 ? body.logs : eventLogs;
  return normalizeJobDetails({ ...(body.job ?? {}), artifacts: body.artifacts ?? body.job?.artifacts }, logs);
}

export async function getScrapeJobDownload(jobId: string): Promise<{ filename: string; downloadUrl: string }> {
  if (!isAwsMode()) {
    const response = await fetch(`/api/scrape-jobs/download?jobId=${encodeURIComponent(jobId)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `Failed to download scrape job: ${response.status}`);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filenameMatch = disposition.match(/filename="([^"]+)"/i);
    return {
      filename: filenameMatch?.[1] || "claim-status-output.xlsx",
      downloadUrl: URL.createObjectURL(blob),
    };
  }

  const apiUrl = requireAwsApiUrl();
  const response = await fetch(`${apiUrl}/jobs/${encodeURIComponent(jobId)}/download`, {
    headers: { ...requireAwsAuthHeaders() },
  });
  await throwForAwsAuthResponse(response);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Failed to create download URL: ${response.status}`);
  }

  const body = await response.json() as { filename?: string; downloadUrl?: string };
  if (!body.downloadUrl) throw new Error("Download URL was not returned.");
  return {
    filename: body.filename || "claim-status-output.xlsx",
    downloadUrl: body.downloadUrl,
  };
}

async function subscribeToAwsScrapeJobEvents(options: {
  jobId: string;
  signal: AbortSignal;
  onEvent: (event: ScrapeJobEvent) => Promise<void> | void;
  onStreamError: (error: unknown) => void;
}): Promise<void> {
  let after = 0;
  const apiUrl = requireAwsApiUrl();
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let socketErrorAlreadyHandled = false;
  let downloadableEventSeen = false;
  let terminal = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const shouldKeepSocketOpen = () =>
    Boolean(AWS_WS_URL) &&
    !terminal &&
    !options.signal.aborted &&
    (typeof navigator === "undefined" || navigator.onLine !== false);

  const closeSocket = () => {
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  };

  const scheduleReconnect = () => {
    clearReconnectTimer();
    if (!shouldKeepSocketOpen()) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt, 5));
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  };

  const openSocket = () => {
    if (!shouldKeepSocketOpen()) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const token = getCognitoAccessToken();
    const url = new URL(AWS_WS_URL);
    url.searchParams.set("jobId", options.jobId);
    if (token) url.searchParams.set("token", token);
    socket = new WebSocket(url.toString());
    socketErrorAlreadyHandled = false;
    socket.onopen = () => {
      reconnectAttempt = 0;
    };
    socket.onmessage = async (message) => {
      try {
        const parsed = JSON.parse(String(message.data)) as ScrapeJobEvent & { id?: number; payload?: ScrapeJobEvent };
        if (typeof parsed.id === "number") after = Math.max(after, parsed.id);
        const event = parsed.payload ?? parsed;
        if (isDownloadableOutputEvent(event)) {
          downloadableEventSeen = true;
        }
        await options.onEvent(event);
      } catch (error) {
        options.onStreamError(error);
      }
    };
    socket.onerror = () => {
      socketErrorAlreadyHandled = true;
      closeSocket();
      scheduleReconnect();
    };
    socket.onclose = () => {
      socket = null;
      if (socketErrorAlreadyHandled) {
        socketErrorAlreadyHandled = false;
        return;
      }
      scheduleReconnect();
    };
  };

  const handleVisibilityOrNetworkChange = () => {
    if (shouldKeepSocketOpen()) {
      openSocket();
    } else {
      clearReconnectTimer();
      closeSocket();
    }
  };

  const cleanup = () => {
    terminal = true;
    clearReconnectTimer();
    closeSocket();
    window.removeEventListener("online", handleVisibilityOrNetworkChange);
    window.removeEventListener("offline", handleVisibilityOrNetworkChange);
    document.removeEventListener("visibilitychange", handleVisibilityOrNetworkChange);
  };

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("online", handleVisibilityOrNetworkChange);
    window.addEventListener("offline", handleVisibilityOrNetworkChange);
    document.addEventListener("visibilitychange", handleVisibilityOrNetworkChange);
    options.signal.addEventListener("abort", cleanup, { once: true });
    openSocket();
  }

  while (!options.signal.aborted) {
    try {
      const response = await fetch(`${apiUrl}/jobs/${encodeURIComponent(options.jobId)}?after=${after}`, {
        headers: { ...requireAwsAuthHeaders() },
        signal: options.signal,
      });
      await throwForAwsAuthResponse(response);
      if (response.ok) {
        const body = await response.json() as {
          job?: { status?: string; errorMessage?: string | null };
          events?: Array<{ id: number; payload: ScrapeJobEvent }>;
        };
        const jobStatus = body.job?.status;
        for (const event of body.events ?? []) {
          after = Math.max(after, event.id);
          if (isOtpReplayEvent(event.payload) && jobStatus !== "waiting_otp") {
            continue;
          }
          if (isDownloadableOutputEvent(event.payload)) {
            downloadableEventSeen = true;
          }
          if (event.payload.type === "failed") {
            await options.onEvent({ ...event.payload, type: "error", message: event.payload.message || body.job?.errorMessage || "Workflow failed." });
            continue;
          }
          await options.onEvent(event.payload);
        }
        if (jobStatus === "completed" || jobStatus === "failed" || jobStatus === "cancelled") {
          terminal = true;
          if (jobStatus === "failed") {
            await options.onEvent({ type: "error", message: body.job?.errorMessage || "Workflow failed." });
          }
          if (jobStatus === "cancelled" || !downloadableEventSeen) {
            try {
              const filename = await autoDownloadTerminalJobOutput(options.jobId);
              if (filename) {
                const label = jobStatus === "completed" ? "Output" : "Partial output";
                await options.onEvent({ type: "log", message: `${label} ready. Download started for ${filename}.` });
              }
            } catch (error) {
              await options.onEvent({ type: "log", message: `Automatic output download did not start: ${error instanceof Error ? error.message : "Unknown error"}` });
            }
          }
          await options.onEvent({ type: "done" });
          cleanup();
          return;
        }
      }
    } catch (error) {
      if (!options.signal.aborted) options.onStreamError(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  cleanup();
}

function isOtpReplayEvent(event: ScrapeJobEvent): boolean {
  return event.type === "input_request" || event.type === "otp_required";
}

function isDownloadableOutputEvent(event: ScrapeJobEvent): boolean {
  if (event.type !== "file_download" && event.type !== "output_snapshot") return false;
  const filename = String(event.filename || "").toLowerCase();
  const mimeType = String(event.mimeType || "").toLowerCase();
  if (filename.endsWith(".pdf") || mimeType === "application/pdf") return false;
  if (filename.endsWith(".log") || mimeType === "text/plain") return false;
  return true;
}

function autoDownloadStorageKey(jobId: string): string {
  return `claim-status:auto-downloaded:${jobId}`;
}

function hasAutoDownloadedJob(jobId: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.sessionStorage.getItem(autoDownloadStorageKey(jobId)) === "1";
  } catch {
    return false;
  }
}

function rememberAutoDownloadedJob(jobId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(autoDownloadStorageKey(jobId), "1");
  } catch {
    // Ignore storage failures.
  }
}

async function autoDownloadTerminalJobOutput(jobId: string): Promise<string | null> {
  if (hasAutoDownloadedJob(jobId)) return null;
  let output: { filename: string; downloadUrl: string };
  try {
    output = await getScrapeJobDownload(jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No output is available yet")) return null;
    throw error;
  }
  const link = document.createElement("a");
  link.href = output.downloadUrl;
  link.download = output.filename;
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  rememberAutoDownloadedJob(jobId);
  return output.filename;
}
