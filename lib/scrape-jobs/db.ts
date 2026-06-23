import { Pool, type QueryResult, type QueryResultRow } from "pg";

export type PersistentScrapeJobStatus = "running" | "waiting_resume" | "completed" | "failed" | "cancelled";

export type PersistentScrapeJob = {
  jobId: string;
  userId: string;
  portalId: string;
  status: PersistentScrapeJobStatus;
  currentCompleted: number;
  totalRows: number;
  claimFileName: string;
  loginFileName: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  logs: string[];
  artifacts: PersistentScrapeJobArtifact[];
};

export type PersistentScrapeJobArtifact = {
  id: number;
  jobId: string;
  rowIndex: number | null;
  artifactType: string;
  filename: string;
  mimeType: string;
  pathOrKey: string;
  createdAt: string;
  contentBase64?: string;
};

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;
const DB_CONNECT_TIMEOUT_MS = 5000;
const DB_QUERY_TIMEOUT_MS = 6000;

function getPool(): Pool {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be configured for scrape job persistence.");
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
      await ensureScrapeJobSchema();
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

async function ensureScrapeJobSchema(): Promise<void> {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    const db = getPool();
    await db.query(`
      CREATE TABLE IF NOT EXISTS iehp_scrape_jobs (
        job_id VARCHAR(100) PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        portal_id VARCHAR(50) NOT NULL,
        status VARCHAR(30) NOT NULL,
        current_completed INTEGER NOT NULL DEFAULT 0,
        total_rows INTEGER NOT NULL DEFAULT 0,
        claim_file_name TEXT NOT NULL DEFAULT '',
        login_file_name TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS iehp_scrape_job_logs (
        id BIGSERIAL PRIMARY KEY,
        job_id VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS iehp_scrape_job_artifacts (
        id BIGSERIAL PRIMARY KEY,
        job_id VARCHAR(100) NOT NULL,
        row_index INTEGER,
        artifact_type VARCHAR(50) NOT NULL,
        filename TEXT,
        mime_type TEXT,
        path_or_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS iehp_scrape_jobs_user_status_idx
      ON iehp_scrape_jobs (user_id, status, updated_at DESC)
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS iehp_scrape_job_logs_job_id_idx
      ON iehp_scrape_job_logs (job_id, id)
    `);
  })();

  return schemaReady;
}

export async function createPersistentScrapeJob(params: {
  jobId: string;
  userId: string;
  portalId: string;
  claimFileName?: string;
  loginFileName?: string;
  totalRows?: number;
  currentCompleted?: number;
}): Promise<void> {
  await queryWithRetry(
    `
      INSERT INTO iehp_scrape_jobs (
        job_id, user_id, portal_id, status, current_completed, total_rows, claim_file_name, login_file_name, created_at, updated_at, finished_at
      )
      VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, NOW(), NOW(), NULL)
      ON CONFLICT (job_id) DO UPDATE
      SET status = 'running',
          current_completed = EXCLUDED.current_completed,
          total_rows = EXCLUDED.total_rows,
          claim_file_name = EXCLUDED.claim_file_name,
          login_file_name = EXCLUDED.login_file_name,
          updated_at = NOW(),
          finished_at = NULL
    `,
    [
      params.jobId,
      params.userId,
      params.portalId,
      params.currentCompleted ?? 0,
      params.totalRows ?? 0,
      params.claimFileName ?? "",
      params.loginFileName ?? "",
    ],
  );
}

export async function getActiveScrapeJobForUser(userId: string): Promise<PersistentScrapeJob | null> {
  const result = await queryWithRetry<{
    job_id: string;
    user_id: string;
    portal_id: string;
    status: PersistentScrapeJobStatus;
    current_completed: number;
    total_rows: number;
    claim_file_name: string;
    login_file_name: string;
    created_at: string;
    updated_at: string;
    finished_at: string | null;
  }>(
    `
      SELECT job_id, user_id, portal_id, status, current_completed, total_rows, claim_file_name, login_file_name, created_at, updated_at, finished_at
      FROM iehp_scrape_jobs
      WHERE user_id = $1
        AND status IN ('running', 'waiting_resume')
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [userId],
  );

  const row = result.rows[0];
  if (!row) return null;
  const logs = await getScrapeJobLogs(row.job_id);
  const artifacts = await getScrapeJobArtifacts(row.job_id);
  return {
    jobId: row.job_id,
    userId: row.user_id,
    portalId: row.portal_id,
    status: row.status,
    currentCompleted: row.current_completed,
    totalRows: row.total_rows,
    claimFileName: row.claim_file_name,
    loginFileName: row.login_file_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    logs,
    artifacts,
  };
}

export async function getScrapeJobByIdForUser(jobId: string, userId: string): Promise<PersistentScrapeJob | null> {
  const result = await queryWithRetry<{
    job_id: string;
    user_id: string;
    portal_id: string;
    status: PersistentScrapeJobStatus;
    current_completed: number;
    total_rows: number;
    claim_file_name: string;
    login_file_name: string;
    created_at: string;
    updated_at: string;
    finished_at: string | null;
  }>(
    `
      SELECT job_id, user_id, portal_id, status, current_completed, total_rows, claim_file_name, login_file_name, created_at, updated_at, finished_at
      FROM iehp_scrape_jobs
      WHERE job_id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [jobId, userId],
  );

  const row = result.rows[0];
  if (!row) return null;
  const logs = await getScrapeJobLogs(row.job_id);
  const artifacts = await getScrapeJobArtifacts(row.job_id);
  return {
    jobId: row.job_id,
    userId: row.user_id,
    portalId: row.portal_id,
    status: row.status,
    currentCompleted: row.current_completed,
    totalRows: row.total_rows,
    claimFileName: row.claim_file_name,
    loginFileName: row.login_file_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    logs,
    artifacts,
  };
}

async function getScrapeJobLogs(jobId: string): Promise<string[]> {
  const result = await queryWithRetry<{ message: string }>(
    `
      SELECT message
      FROM iehp_scrape_job_logs
      WHERE job_id = $1
      ORDER BY id
    `,
    [jobId],
  );
  return result.rows.map((row) => row.message);
}

async function getScrapeJobArtifacts(jobId: string): Promise<PersistentScrapeJobArtifact[]> {
  const result = await queryWithRetry<{
    id: number;
    job_id: string;
    row_index: number | null;
    artifact_type: string;
    filename: string | null;
    mime_type: string | null;
    path_or_key: string | null;
    created_at: string;
  }>(
    `
      SELECT id, job_id, row_index, artifact_type, filename, mime_type, path_or_key, created_at
      FROM iehp_scrape_job_artifacts
      WHERE job_id = $1
      ORDER BY id
    `,
    [jobId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    rowIndex: row.row_index,
    artifactType: row.artifact_type,
    filename: row.filename ?? "",
    mimeType: row.mime_type ?? "",
    pathOrKey: row.path_or_key ?? "",
    createdAt: row.created_at,
  }));
}

export async function appendScrapeJobLog(jobId: string, message: string): Promise<void> {
  await queryWithRetry(
    `
      INSERT INTO iehp_scrape_job_logs (job_id, message)
      VALUES ($1, $2)
    `,
    [jobId, message],
  );
}

export async function appendScrapeJobArtifact(params: {
  jobId: string;
  rowIndex?: number | null;
  artifactType: string;
  filename?: string;
  mimeType?: string;
  pathOrKey?: string;
}): Promise<void> {
  await queryWithRetry(
    `
      INSERT INTO iehp_scrape_job_artifacts (job_id, row_index, artifact_type, filename, mime_type, path_or_key)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [params.jobId, params.rowIndex ?? null, params.artifactType, params.filename ?? null, params.mimeType ?? null, params.pathOrKey ?? null],
  );
}

export async function updateScrapeJobSnapshot(params: {
  jobId: string;
  status?: PersistentScrapeJobStatus;
  currentCompleted?: number;
  totalRows?: number;
}): Promise<void> {
  await queryWithRetry(
    `
      UPDATE iehp_scrape_jobs
      SET status = COALESCE($2, status),
          current_completed = COALESCE($3, current_completed),
          total_rows = COALESCE($4, total_rows),
          updated_at = NOW(),
          finished_at = CASE WHEN COALESCE($2, status) IN ('completed', 'failed', 'cancelled') THEN NOW() ELSE finished_at END
      WHERE job_id = $1
    `,
    [params.jobId, params.status ?? null, params.currentCompleted ?? null, params.totalRows ?? null],
  );
}
