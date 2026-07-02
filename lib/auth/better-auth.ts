import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { username } from "better-auth/plugins/username";
import { getDb } from "@/db";
import * as betterAuthSchema from "@/db/schema/better-auth";
import { hashPassword, verifyPassword } from "./password";

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

export const betterAuthInstance = betterAuth({
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
      adminRoles: ["ADMIN"],
      defaultRole: "USER",
    }),
    nextCookies(),
  ],
});
