export type ApiEvent = {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    authorizer?: {
      jwt?: {
        claims?: Record<string, string | undefined>;
      };
    };
    connectionId?: string;
    domainName?: string;
    stage?: string;
  };
};

export type ApiResponse = {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
};

export type AuthRole = "ADMIN" | "DEVELOPER" | "USER";

function normalizeRole(value: unknown): AuthRole {
  const raw = String(value ?? "").trim().toUpperCase();
  if (raw === "ADMIN") return "ADMIN";
  if (raw === "DEVELOPER" || raw === "DEVELOPER_ADMIN") return "DEVELOPER";
  return "USER";
}

function getClaimGroups(claims: Record<string, string | undefined> | undefined): string[] {
  const rawGroups = claims?.["cognito:groups"] || claims?.groups || "";
  return rawGroups
    .split(",")
    .map((group) => group.trim().toUpperCase())
    .filter(Boolean);
}

export function jsonResponse(statusCode: number, value: unknown): ApiResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    },
    body: JSON.stringify(value),
  };
}

export function parseJsonBody<T>(event: ApiEvent): T {
  if (!event.body) return {} as T;
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(text) as T;
}

export function getAuthUserId(event: ApiEvent): string {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const userId = claims?.sub || claims?.username || claims?.["cognito:username"];
  if (!userId) throw new Error("Authenticated Cognito user was not available.");
  return userId;
}

export function getAuthRole(event: ApiEvent): AuthRole {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const groups = getClaimGroups(claims);
  if (groups.includes("ADMIN")) return "ADMIN";
  if (groups.includes("DEVELOPER") || groups.includes("DEVELOPERS")) return "DEVELOPER";
  return normalizeRole(claims?.role || claims?.["custom:role"]);
}

export function hasFullWorkflowAccess(event: ApiEvent): boolean {
  const role = getAuthRole(event);
  return role === "ADMIN" || role === "DEVELOPER";
}

export function getAuthUserSnapshot(event: ApiEvent): { userId: string; email: string; name: string; role: AuthRole } {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const userId = getAuthUserId(event);
  const email = claims?.email || claims?.username || claims?.["cognito:username"] || "unknown";
  const name = claims?.name || claims?.given_name || claims?.preferred_username || email || "unknown";
  return {
    userId,
    email: email.trim() || "unknown",
    name: name.trim() || "unknown",
    role: getAuthRole(event),
  };
}

export function getJobId(event: ApiEvent): string {
  const jobId = event.pathParameters?.jobId || event.queryStringParameters?.jobId || "";
  if (!jobId.trim()) throw new Error("Missing jobId.");
  return jobId.trim();
}

export function createJobId(): string {
  return crypto.randomUUID();
}
