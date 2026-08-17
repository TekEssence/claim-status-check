import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { username } from "better-auth/plugins/username";
import { getDb, getDbPoolVersion, hasUsableDbPool } from "@/db";
import * as betterAuthSchema from "@/db/schema/better-auth";
import { hashPassword, verifyPassword } from "./password";
import { AUTH_IDLE_TIMEOUT_SECONDS, AUTH_SESSION_REFRESH_AGE_SECONDS } from "./session-config";

function getBaseUrl(): string {
  return (
    process.env.BETTER_AUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "http://localhost:3000"
  );
}

function getSecret(): string {
  return (
    process.env.BETTER_AUTH_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.AUTH_SESSION_SECRET ||
    "iehp-better-auth-dev-secret"
  );
}

function createBetterAuthInstance() {
  return betterAuth({
    baseURL: getBaseUrl(),
    basePath: "/api/better-auth",
    secret: getSecret(),
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: betterAuthSchema,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    user: {
      modelName: "authUsers",
      additionalFields: {
        mustResetPassword: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
        isActive: {
          type: "boolean",
          required: false,
          defaultValue: true,
          input: false,
        },
        legacyUserId: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    session: {
      modelName: "authSessions",
      expiresIn: AUTH_IDLE_TIMEOUT_SECONDS,
      updateAge: AUTH_SESSION_REFRESH_AGE_SECONDS,
    },
    account: {
      modelName: "authAccounts",
    },
    verification: {
      modelName: "authVerifications",
    },
    trustedOrigins: [getBaseUrl()],
    plugins: [
      username(),
      admin({
        adminRoles: ["ADMIN", "DEVELOPER"],
        defaultRole: "USER",
        roles: {
          ADMIN: adminAc,
          DEVELOPER: adminAc,
          USER: userAc,
        },
      }),
      nextCookies(),
    ],
  });
}

export let betterAuthInstance = createBetterAuthInstance();
let betterAuthPoolVersion = getDbPoolVersion();

export function resetBetterAuthInstance(): void {
  betterAuthInstance = createBetterAuthInstance();
  betterAuthPoolVersion = getDbPoolVersion();
}

export function getBetterAuthInstance() {
  if (!hasUsableDbPool() || betterAuthPoolVersion !== getDbPoolVersion()) {
    resetBetterAuthInstance();
  }
  return betterAuthInstance;
}
