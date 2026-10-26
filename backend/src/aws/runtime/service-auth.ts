import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiEvent } from "./http";

export class ServiceAuthError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function header(event: ApiEvent, name: string): string {
  const entry = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1]?.trim() ?? "";
}

export function authenticateServiceWithToken(event: ApiEvent): { clientSystem: string; token: string } {
  const rawConfig = process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON?.trim();
  if (!rawConfig) throw new ServiceAuthError(503, "Claim Status service authentication is not configured.");
  let configured: Record<string, unknown>;
  try {
    configured = JSON.parse(rawConfig) as Record<string, unknown>;
  } catch {
    throw new ServiceAuthError(503, "Claim Status service authentication is misconfigured.");
  }
  const clientSystem = header(event, "x-client-system").toUpperCase();
  const authorization = header(event, "authorization");
  const provided = /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, "") : "";
  const expected = configured[clientSystem];
  if (!/^[A-Z][A-Z0-9_-]{1,79}$/.test(clientSystem) || typeof expected !== "string" || expected.length < 32 || !provided) {
    throw new ServiceAuthError(401, "Invalid service credentials.");
  }
  const actualDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(actualDigest, expectedDigest)) throw new ServiceAuthError(401, "Invalid service credentials.");
  return { clientSystem, token: provided };
}

export function authenticateService(event: ApiEvent): string {
  return authenticateServiceWithToken(event).clientSystem;
}
