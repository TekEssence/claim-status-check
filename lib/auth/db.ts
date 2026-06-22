import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { loadBackendEnv } from "@/lib/server-env";
import { hashPassword, verifyPassword } from "./password";

export type AuthUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "USER";
  mustResetPassword: boolean;
};

export type ManagedUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "USER";
  isActive: boolean;
  mustResetPassword: boolean;
};

let pool: Pool | null = null;
const DB_CONNECT_TIMEOUT_MS = 5000;
const DB_QUERY_TIMEOUT_MS = 6000;

function getPool(): Pool {
  loadBackendEnv();

  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be configured for database authentication.");
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

function isRetryableDbError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "57P01"].includes(code);
}

async function resetPool(): Promise<void> {
  if (!pool) return;
  const currentPool = pool;
  pool = null;
  await currentPool.end().catch(() => {});
}

async function queryWithRetry<T extends QueryResultRow>(text: string, params: unknown[]): Promise<QueryResult<T>> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await getPool().query<T>(text, params);
    } catch (error) {
      if (attempt < 2 && isRetryableDbError(error)) {
        await resetPool();
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Database query failed after retry.");
}

export async function authenticateUser(username: string, password: string): Promise<AuthUser | null> {
  const result = await queryWithRetry<{ user_id: string; username: string; email: string; role: "ADMIN" | "USER"; password_hash: string; must_reset_password: boolean }>(
    `
      SELECT user_id, username, email, role, password_hash, must_reset_password
      FROM iehp_auth_users
      WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1))
        AND is_active = TRUE
      LIMIT 1
    `,
    [username.trim()],
  );

  const row = result.rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return null;
  }

  await queryWithRetry(
    `
      UPDATE iehp_auth_users
      SET last_login_at = NOW(),
          updated_at = NOW()
      WHERE user_id = $1
    `,
    [row.user_id],
  );

  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    role: row.role,
    mustResetPassword: row.must_reset_password,
  };
}

export async function getActiveAuthUser(userId: string): Promise<AuthUser | null> {
  const result = await queryWithRetry<{ user_id: string; username: string; email: string; role: "ADMIN" | "USER"; must_reset_password: boolean }>(
    `
      SELECT user_id, username, email, role, must_reset_password
      FROM iehp_auth_users
      WHERE user_id = $1
        AND is_active = TRUE
      LIMIT 1
    `,
    [userId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    role: row.role,
    mustResetPassword: row.must_reset_password,
  };
}

export async function resetPasswordByUsername(username: string, password: string): Promise<AuthUser | null> {
  const passwordHash = await hashPassword(password);
  const result = await queryWithRetry<{ user_id: string; username: string; email: string; role: "ADMIN" | "USER"; must_reset_password: boolean }>(
    `
      UPDATE iehp_auth_users
      SET password_hash = $2,
          must_reset_password = FALSE,
          updated_at = NOW()
      WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1))
        AND is_active = TRUE
      RETURNING user_id, username, email, role, must_reset_password
    `,
    [username.trim(), passwordHash],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    role: row.role,
    mustResetPassword: row.must_reset_password,
  };
}

export async function listManagedUsers(): Promise<ManagedUser[]> {
  const result = await queryWithRetry<{
    user_id: string;
    username: string;
    email: string | null;
    role: "ADMIN" | "USER";
    is_active: boolean;
    must_reset_password: boolean;
  }>(
    `
      SELECT user_id, username, email, role, is_active, must_reset_password
      FROM iehp_auth_users
      ORDER BY user_id
    `,
    [],
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    email: row.email || row.username,
    role: row.role,
    isActive: row.is_active,
    mustResetPassword: row.must_reset_password,
  }));
}

export async function createManagedUser(email: string, temporaryPassword: string): Promise<AuthUser> {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(temporaryPassword);
  const result = await queryWithRetry<{
    user_id: string;
    username: string;
    email: string;
    role: "ADMIN" | "USER";
    must_reset_password: boolean;
  }>(
    `
      INSERT INTO iehp_auth_users (username, email, password_hash, role, must_reset_password, is_active, created_at, updated_at)
      VALUES ($1, $1, $2, 'USER', TRUE, TRUE, NOW(), NOW())
      RETURNING user_id, username, email, role, must_reset_password
    `,
    [normalizedEmail, passwordHash],
  );

  const row = result.rows[0];
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    role: row.role,
    mustResetPassword: row.must_reset_password,
  };
}

export async function updateManagedUserEmail(userId: string, email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  await queryWithRetry(
    `
      UPDATE iehp_auth_users
      SET username = $2,
          email = $2,
          updated_at = NOW()
      WHERE user_id = $1
    `,
    [userId, normalizedEmail],
  );
}

export async function deactivateManagedUser(userId: string): Promise<void> {
  await queryWithRetry(
    `
      UPDATE iehp_auth_users
      SET is_active = FALSE,
          updated_at = NOW()
      WHERE user_id = $1
    `,
    [userId],
  );
}
