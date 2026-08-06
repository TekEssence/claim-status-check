import type { APIResponse } from "playwright-core";

export class AvailityNetworkError extends Error {
  status: number;
  traceId: string;
  completeCode: string;
  retryable: boolean;
  authFailure: boolean;

  constructor(message: string, options: {
    status?: number;
    traceId?: string;
    completeCode?: string | number;
    retryable?: boolean;
    authFailure?: boolean;
  } = {}) {
    super(message);
    this.name = "AvailityNetworkError";
    this.status = options.status ?? 0;
    this.traceId = String(options.traceId || "");
    this.completeCode = String(options.completeCode ?? "");
    this.retryable = Boolean(options.retryable);
    this.authFailure = Boolean(options.authFailure);
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

export function isAuthHttpStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function extractTraceId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const traceIds = (payload as { traceIds?: Record<string, unknown> }).traceIds;
  return String(traceIds?.AVAILITY_TRACE_ID || traceIds?.traceId || "");
}

export function summarizeErrors(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const errors = (payload as { errors?: unknown[] }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return "";

  return errors
    .slice(0, 3)
    .map((error) => {
      if (!error || typeof error !== "object") {
        return String(error || "").trim();
      }
      const record = error as Record<string, unknown>;
      return String(record.code || record.errorCode || record.message || record.detail || record.description || "structured error").trim();
    })
    .filter(Boolean)
    .join("; ");
}

export async function readJsonSafely(response: APIResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function assertSuccessfulJsonResponse<T>(response: APIResponse, action: string): Promise<T> {
  const payload = await readJsonSafely(response);
  const status = response.status();

  if (!response.ok()) {
    const traceId = extractTraceId(payload);
    const details = summarizeErrors(payload);
    throw new AvailityNetworkError(
      `${action} failed with HTTP ${status}${details ? `: ${details}` : ""}${traceId ? ` (trace ${traceId})` : ""}.`,
      {
        status,
        traceId,
        retryable: isRetryableHttpStatus(status),
        authFailure: isAuthHttpStatus(status),
      },
    );
  }

  if (payload === null || payload === undefined) {
    throw new AvailityNetworkError(`${action} returned an empty or non-JSON response.`, {
      status,
      retryable: true,
    });
  }

  const completeCode = payload && typeof payload === "object" ? (payload as { completeCode?: unknown }).completeCode : "";
  const errorSummary = summarizeErrors(payload);
  if (errorSummary) {
    throw new AvailityNetworkError(
      `${action} returned application errors: ${errorSummary}${extractTraceId(payload) ? ` (trace ${extractTraceId(payload)})` : ""}.`,
      {
        status,
        traceId: extractTraceId(payload),
        completeCode: String(completeCode ?? ""),
      },
    );
  }

  return payload as T;
}
