import { toNextJsHandler } from "better-auth/next-js";
import { betterAuthInstance } from "@/lib/auth/better-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(betterAuthInstance);
