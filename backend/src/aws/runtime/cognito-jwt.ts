import { webcrypto } from "node:crypto";

type JwtHeader = {
  alg?: string;
  kid?: string;
};

type CognitoJwtPayload = {
  aud?: string;
  client_id?: string;
  exp?: number;
  iss?: string;
  sub?: string;
  token_use?: string;
  username?: string;
  "cognito:username"?: string;
};

type Jwks = {
  keys: CognitoJwk[];
};

type CognitoJwk = JsonWebKey & {
  kid?: string;
};

let cachedJwks: { issuer: string; keys: CognitoJwk[]; expiresAt: number } | null = null;

function base64UrlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function parseJsonPart<T>(value: string): T {
  return JSON.parse(base64UrlDecode(value).toString("utf8")) as T;
}

async function getJwks(issuer: string): Promise<CognitoJwk[]> {
  const now = Date.now();
  if (cachedJwks?.issuer === issuer && cachedJwks.expiresAt > now) {
    return cachedJwks.keys;
  }

  const response = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`);
  if (!response.ok) throw new Error(`Failed to load Cognito JWKS: ${response.status}`);
  const body = await response.json() as Jwks;
  cachedJwks = { issuer, keys: body.keys, expiresAt: now + 60 * 60 * 1000 };
  return body.keys;
}

export async function verifyCognitoJwt(token: string): Promise<CognitoJwtPayload> {
  const issuer = process.env.COGNITO_ISSUER?.trim();
  const clientId = process.env.COGNITO_CLIENT_ID?.trim();
  if (!issuer || !clientId) throw new Error("COGNITO_ISSUER and COGNITO_CLIENT_ID must be configured.");

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format.");

  const header = parseJsonPart<JwtHeader>(parts[0]);
  const payload = parseJsonPart<CognitoJwtPayload>(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported JWT header.");
  if (payload.iss !== issuer) throw new Error("Invalid JWT issuer.");
  if (!payload.exp || payload.exp * 1000 <= Date.now()) throw new Error("JWT has expired.");
  if (payload.client_id !== clientId && payload.aud !== clientId) throw new Error("Invalid JWT audience.");

  const jwk = (await getJwks(issuer)).find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("JWT signing key was not found.");

  const key = await webcrypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await webcrypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(parts[2]),
    Buffer.from(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error("Invalid JWT signature.");

  return payload;
}

export function getUserIdFromVerifiedJwt(payload: CognitoJwtPayload): string {
  const userId = payload.sub || payload.username || payload["cognito:username"] || "";
  if (!userId) throw new Error("JWT did not contain a Cognito user id.");
  return userId;
}
