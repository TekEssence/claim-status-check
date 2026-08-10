const TOKEN_KEY = "cognito_access_token";

export function isCognitoMode(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_COGNITO_DOMAIN &&
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  );
}

export function getCognitoAccessToken(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(TOKEN_KEY) || window.localStorage.getItem(TOKEN_KEY) || "";
}

export function clearCognitoAccessToken(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(TOKEN_KEY);
}

export function storeCognitoTokenFromHash(): boolean {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  if (!hash) return Boolean(getCognitoAccessToken());
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");
  if (!token) return Boolean(getCognitoAccessToken());
  window.sessionStorage.setItem(TOKEN_KEY, token);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return true;
}

export function redirectToCognitoLogin(): void {
  if (typeof window === "undefined") return;
  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
  if (!domain || !clientId) return;
  const url = new URL(`${domain.replace(/\/+$/, "")}/login`);
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
