const TOKEN_KEY = "cognito_access_token";
const ID_TOKEN_KEY = "cognito_id_token";
const RETURN_PATH_KEY = "cognito_return_path";

export type CognitoRole = "ADMIN" | "DEVELOPER" | "USER";

export type CognitoUserProfile = {
  userId: string;
  username: string;
  email: string;
  role: CognitoRole;
};

type CognitoJwtPayload = {
  sub?: string;
  exp?: number;
  email?: string;
  username?: string;
  name?: string;
  preferred_username?: string;
  "cognito:username"?: string;
  "cognito:groups"?: string[] | string;
  "custom:role"?: string;
  role?: string;
};

type CognitoTokens = {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
};

type CognitoChallenge = {
  name: string;
  session: string;
  email: string;
};

export type CognitoPasswordLoginResult = {
  user: CognitoUserProfile | null;
  challenge?: CognitoChallenge;
};

function decodeJwtPayload(token: string): CognitoJwtPayload | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    return JSON.parse(window.atob(padded)) as CognitoJwtPayload;
  } catch {
    return null;
  }
}

function normalizeRole(value: unknown): CognitoRole | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "ADMIN") return "ADMIN";
  if (normalized === "DEVELOPER" || normalized === "DEVELOPERS" || normalized === "DEVELOPER_ADMIN") return "DEVELOPER";
  if (normalized === "USER") return "USER";
  return null;
}

function getGroups(payload: CognitoJwtPayload): string[] {
  const rawGroups = payload["cognito:groups"];
  if (Array.isArray(rawGroups)) return rawGroups.map((group) => String(group).trim().toUpperCase()).filter(Boolean);
  if (typeof rawGroups === "string") return rawGroups.split(",").map((group) => group.trim().toUpperCase()).filter(Boolean);
  return [];
}

function formatDisplayNameFromEmail(email: string): string {
  const localPart = email.split("@")[0] || "";
  const firstName = localPart.split(/[._-]+/).find(Boolean) || localPart;
  if (!firstName) return "";
  return firstName[0].toUpperCase() + firstName.slice(1).toLowerCase();
}

export function getCognitoUserProfile(): CognitoUserProfile | null {
  const token = getCognitoIdToken() || getCognitoAccessToken();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const email = String(payload.email || payload.preferred_username || payload.username || "").trim().toLowerCase();
  const groups = getGroups(payload);
  const role =
    groups.includes("ADMIN")
      ? "ADMIN"
      : groups.includes("DEVELOPER") || groups.includes("DEVELOPERS")
        ? "DEVELOPER"
        : normalizeRole(payload["custom:role"]) ?? normalizeRole(payload.role) ?? "USER";
  const readableName = String(payload.name || "").trim();
  const username = readableName || formatDisplayNameFromEmail(email) || String(payload.preferred_username || payload.username || payload["cognito:username"] || "Cognito user");
  return {
    userId: String(payload.sub || payload["cognito:username"] || email || "cognito"),
    username,
    email: email || username,
    role,
  };
}

export function isCognitoMode(): boolean {
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (isLocalHost && process.env.NEXT_PUBLIC_FORCE_AWS_WORKFLOW !== "true") {
      return false;
    }
  }

  return Boolean(
    process.env.NEXT_PUBLIC_COGNITO_DOMAIN &&
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  );
}

export function getCognitoAccessToken(): string {
  if (typeof window === "undefined") return "";
  const token = window.sessionStorage.getItem(TOKEN_KEY) || window.localStorage.getItem(TOKEN_KEY) || "";
  if (!token) return "";
  const payload = decodeJwtPayload(token);
  if (typeof payload?.exp === "number" && payload.exp * 1000 <= Date.now() + 30000) {
    clearCognitoAccessToken();
    return "";
  }
  return token;
}

export function getCognitoIdToken(): string {
  if (typeof window === "undefined") return "";
  const token = window.sessionStorage.getItem(ID_TOKEN_KEY) || window.localStorage.getItem(ID_TOKEN_KEY) || "";
  if (!token) return "";
  const payload = decodeJwtPayload(token);
  if (typeof payload?.exp === "number" && payload.exp * 1000 <= Date.now() + 30000) {
    clearCognitoAccessToken();
    return "";
  }
  return token;
}

export function clearCognitoAccessToken(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(TOKEN_KEY);
  window.sessionStorage.removeItem(ID_TOKEN_KEY);
  window.localStorage.removeItem(ID_TOKEN_KEY);
}

export function storeCognitoTokens(tokens: CognitoTokens, remember = false): void {
  if (typeof window === "undefined") return;
  const storage = remember ? window.localStorage : window.sessionStorage;
  storage.setItem(TOKEN_KEY, tokens.accessToken);
  storage.setItem(ID_TOKEN_KEY, tokens.idToken);
  if (remember && tokens.refreshToken) {
    storage.setItem("cognito_refresh_token", tokens.refreshToken);
  }
}

function cognitoApiUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_WORKFLOW_API_URL?.replace(/\/+$/, "") || "";
  if (!base) return path;
  return `${base}${path}`;
}

async function parseAuthResponse(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Authentication request failed.");
  }
  return data;
}

export async function loginWithCognitoEmail(email: string, password: string, remember = false): Promise<CognitoPasswordLoginResult> {
  const response = await fetch(cognitoApiUrl("/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await parseAuthResponse(response) as { tokens?: CognitoTokens; challenge?: CognitoChallenge };
  if (data.challenge) return { user: null, challenge: data.challenge };
  if (!data.tokens) throw new Error("Login failed. Cognito tokens were missing.");
  storeCognitoTokens(data.tokens, remember);
  return { user: getCognitoUserProfile() };
}

export async function startCognitoForgotPassword(email: string): Promise<void> {
  const response = await fetch(cognitoApiUrl("/auth/forgot-password/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  await parseAuthResponse(response);
}

export async function confirmCognitoForgotPassword(email: string, code: string, password: string, confirmPassword: string): Promise<void> {
  const response = await fetch(cognitoApiUrl("/auth/forgot-password/confirm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code, password, confirmPassword }),
  });
  await parseAuthResponse(response);
}

export async function startCognitoSignUp(email: string, username: string, password: string, confirmPassword: string): Promise<{ userConfirmed: boolean }> {
  const response = await fetch(cognitoApiUrl("/auth/signup/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, username, password, confirmPassword }),
  });
  const data = await parseAuthResponse(response) as { userConfirmed?: boolean };
  return { userConfirmed: Boolean(data.userConfirmed) };
}

export async function confirmCognitoSignUp(email: string, code: string): Promise<void> {
  const response = await fetch(cognitoApiUrl("/auth/signup/confirm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  await parseAuthResponse(response);
}

export async function completeCognitoNewPassword(email: string, session: string, password: string, confirmPassword: string, remember = false): Promise<CognitoUserProfile | null> {
  const response = await fetch(cognitoApiUrl("/auth/complete-new-password"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, session, password, confirmPassword }),
  });
  const data = await parseAuthResponse(response) as { tokens?: CognitoTokens };
  if (!data.tokens) throw new Error("Password setup failed. Cognito tokens were missing.");
  storeCognitoTokens(data.tokens, remember);
  return getCognitoUserProfile();
}

export function storeCognitoTokenFromHash(): boolean {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  if (!hash) return Boolean(getCognitoAccessToken());
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");
  const idToken = params.get("id_token");
  if (idToken) {
    window.sessionStorage.setItem(ID_TOKEN_KEY, idToken);
  }
  if (!token) return Boolean(getCognitoAccessToken());
  window.sessionStorage.setItem(TOKEN_KEY, token);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return true;
}

export function consumeCognitoReturnPath(): string {
  if (typeof window === "undefined") return "";
  const value = window.sessionStorage.getItem(RETURN_PATH_KEY) || "";
  window.sessionStorage.removeItem(RETURN_PATH_KEY);
  return value.startsWith("/") ? value : "";
}

export function redirectToCognitoLogin(): void {
  if (typeof window === "undefined") return;
  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
  if (!domain || !clientId) return;
  const returnPath = `${window.location.pathname}${window.location.search}`;
  if (returnPath && returnPath !== "/") {
    window.sessionStorage.setItem(RETURN_PATH_KEY, returnPath);
  }
  const url = new URL(`${domain.replace(/\/+$/, "")}/login`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("redirect_uri", window.location.origin + "/");
  window.location.href = url.toString();
}

export function redirectToCognitoForgotPassword(): void {
  if (typeof window === "undefined") return;
  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
  if (!domain || !clientId) return;
  const url = new URL(`${domain.replace(/\/+$/, "")}/forgotPassword`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("redirect_uri", window.location.origin + "/");
  window.location.href = url.toString();
}

export function redirectToCognitoLogout(): void {
  if (typeof window === "undefined") return;
  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
  clearCognitoAccessToken();
  if (!domain || !clientId) return;
  const url = new URL(`${domain.replace(/\/+$/, "")}/logout`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("logout_uri", window.location.origin + "/");
  window.location.href = url.toString();
}
