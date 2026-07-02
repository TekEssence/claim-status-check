import { and, asc, desc, eq, or } from "drizzle-orm";
import { runDbWithRetry } from "@/db";
import { scrapeJobArtifacts, scrapeJobLogs, scrapeJobs } from "@/db/schema/scrape-jobs";

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

type ScrapeJobRow = typeof scrapeJobs.$inferSelect;

function mapPersistentScrapeJob(
  row: ScrapeJobRow,
  logs: string[],
  artifacts: PersistentScrapeJobArtifact[],
): PersistentScrapeJob {
  return {
    jobId: row.jobId,
    userId: row.userId,
    portalId: row.portalId,
    status: row.status as PersistentScrapeJobStatus,
    currentCompleted: row.currentCompleted,
    totalRows: row.totalRows,
    claimFileName: row.claimFileName,
    loginFileName: row.loginFileName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    logs,
    artifacts,
  };
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
  const now = new Date().toISOString();
  await runDbWithRetry((db) =>
    db
      .insert(scrapeJobs)
      .values({
        jobId: params.jobId,
        userId: params.userId,
        portalId: params.portalId,
        status: "running",
        currentCompleted: params.currentCompleted ?? 0,
        totalRows: params.totalRows ?? 0,
        claimFileName: params.claimFileName ?? "",
        loginFileName: params.loginFileName ?? "",
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      })
      .onConflictDoUpdate({
        target: scrapeJobs.jobId,
        set: {
          status: "running",
          currentCompleted: params.currentCompleted ?? 0,
          totalRows: params.totalRows ?? 0,
          claimFileName: params.claimFileName ?? "",
          loginFileName: params.loginFileName ?? "",
          updatedAt: now,
          finishedAt: null,
        },
      }),
  );
}

export async function getActiveScrapeJobForUser(userId: string): Promise<PersistentScrapeJob | null> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(scrapeJobs)
      .where(
        and(
          eq(scrapeJobs.userId, userId),
          or(
            eq(scrapeJobs.status, "running"),
            eq(scrapeJobs.status, "waiting_resume"),
          ),
        ),
      )
      .orderBy(desc(scrapeJobs.updatedAt))
      .limit(10),
  );

  const row = rows.find((candidate) =>
    candidate.status === "running" ||
    (candidate.status === "waiting_resume" && (candidate.totalRows <= 0 || candidate.currentCompleted < candidate.totalRows)),
  );
  if (!row) return null;
  const logs = await getScrapeJobLogs(row.jobId);
  const artifacts = await getScrapeJobArtifacts(row.jobId);
  return mapPersistentScrapeJob(row, logs, artifacts);
}

export async function getScrapeJobByIdForUser(jobId: string, userId: string): Promise<PersistentScrapeJob | null> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(scrapeJobs)
      .where(and(eq(scrapeJobs.jobId, jobId), eq(scrapeJobs.userId, userId)))
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;
  const logs = await getScrapeJobLogs(row.jobId);
  const artifacts = await getScrapeJobArtifacts(row.jobId);
  return mapPersistentScrapeJob(row, logs, artifacts);
}

async function getScrapeJobLogs(jobId: string): Promise<string[]> {
  const rows = await runDbWithRetry((db) =>
    db
      .select({ message: scrapeJobLogs.message })
      .from(scrapeJobLogs)
      .where(eq(scrapeJobLogs.jobId, jobId))
      .orderBy(asc(scrapeJobLogs.id)),
  );
  return rows.map((row) => row.message);
}

async function getScrapeJobArtifacts(jobId: string): Promise<PersistentScrapeJobArtifact[]> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(scrapeJobArtifacts)
      .where(eq(scrapeJobArtifacts.jobId, jobId))
      .orderBy(asc(scrapeJobArtifacts.id)),
  );

  return rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    rowIndex: row.rowIndex,
    artifactType: row.artifactType,
    filename: row.filename ?? "",
    mimeType: row.mimeType ?? "",
    pathOrKey: row.pathOrKey ?? "",
    createdAt: row.createdAt,
  }));
}

export async function appendScrapeJobLog(jobId: string, message: string): Promise<void> {
  const now = new Date().toISOString();
  await runDbWithRetry((db) =>
    db.insert(scrapeJobLogs).values({
      jobId,
      message,
      createdAt: now,
    }),
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
  const now = new Date().toISOString();
  await runDbWithRetry((db) =>
    db.insert(scrapeJobArtifacts).values({
      jobId: params.jobId,
      rowIndex: params.rowIndex ?? null,
      artifactType: params.artifactType,
      filename: params.filename ?? null,
      mimeType: params.mimeType ?? null,
      pathOrKey: params.pathOrKey ?? null,
      createdAt: now,
    }),
  );
}

export async function updateScrapeJobSnapshot(params: {
  jobId: string;
  status?: PersistentScrapeJobStatus;
  currentCompleted?: number;
  totalRows?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  const existingRows = await runDbWithRetry((db) =>
    db
      .select()
      .from(scrapeJobs)
      .where(eq(scrapeJobs.jobId, params.jobId))
      .limit(1),
  );
  const existing = existingRows[0];
  if (!existing) {
    return;
  }

  const nextStatus = params.status ?? (existing.status as PersistentScrapeJobStatus);
  const isTerminalStatus = nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled";

  await runDbWithRetry((db) =>
    db
      .update(scrapeJobs)
      .set({
        status: nextStatus,
        currentCompleted: params.currentCompleted ?? existing.currentCompleted,
        totalRows: params.totalRows ?? existing.totalRows,
        updatedAt: now,
        finishedAt: isTerminalStatus ? now : existing.finishedAt,
      })
      .where(eq(scrapeJobs.jobId, params.jobId)),
  );
}
