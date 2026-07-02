import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as betterAuthSchema from "./schema/better-auth";
import * as scrapeJobsSchema from "./schema/scrape-jobs";

const schema = {
  ...betterAuthSchema,
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
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "57P01"].includes(code);
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
