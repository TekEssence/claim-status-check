import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as betterAuthSchema from "./schema/better-auth";
import * as automationJobsSchema from "./schema/automation-jobs";
import * as scrapeJobsSchema from "./schema/scrape-jobs";

const schema = {
  ...betterAuthSchema,
  ...automationJobsSchema,
  ...scrapeJobsSchema,
};

let pool: Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;

const DB_CONNECT_TIMEOUT_MS = 5000;
const DB_QUERY_TIMEOUT_MS = 6000;

export function getPool(): Pool {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be configured for database access.");
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 10000,
    query_timeout: DB_QUERY_TIMEOUT_MS,
    statement_timeout: DB_QUERY_TIMEOUT_MS,
  });

  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  db = drizzle(getPool(), { schema });
  return db;
}

export function isRetryableDbError(error: unknown): boolean {
  const retryableCodes = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "57P01"]);
  const retryableMessages = [
    "connection timeout",
    "connection terminated",
    "terminating connection",
    "query read timeout",
  ];

  let current: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; current && depth < 8 && !visited.has(current); depth++) {
    visited.add(current);
    const code = typeof current === "object" && "code" in current
      ? String((current as { code?: unknown }).code ?? "")
      : "";
    const message = current instanceof Error ? current.message.toLowerCase() : String(current).toLowerCase();
    if (retryableCodes.has(code) || retryableMessages.some((part) => message.includes(part))) {
      return true;
    }
    current = typeof current === "object" && current !== null && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return false;
}

export async function resetDbPool(): Promise<void> {
  if (!pool) return;
  const currentPool = pool;
  pool = null;
  db = null;
  await currentPool.end().catch(() => {});
}

export async function runDbWithRetry<T>(operation: (database: NodePgDatabase<typeof schema>) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await operation(getDb());
    } catch (error) {
      if (attempt < 2 && isRetryableDbError(error)) {
        await resetDbPool();
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Database query failed after retry.");
}
