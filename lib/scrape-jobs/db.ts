import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { isRetryableDbError, runDbWithRetry } from "@/db";
import {
  automationJobArtifacts,
  automationJobLogs,
  automationJobs,
} from "@/db/schema/automation-jobs";

export type PersistentScrapeJobStatus = "queued" | "running" | "waiting_otp" | "waiting_resume" | "cancelling" | "completed" | "failed" | "cancelled";

export type PersistentScrapeJob = {
  jobId: string;
  userId: string;
  workflowId: string;
  portalId: string;
  status: PersistentScrapeJobStatus;
  currentCompleted: number;
  totalRows: number;
  claimFileName: string;
  loginFileName: string;
  createdByUserId: string;
  createdByEmail: string;
  createdByName: string;
  startedAt: string | null;
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
  contentText?: string;
};

export type UserDashboardStats = {
  availablePortals: number;
  completedClaimsToday: number;
  failedJobsToday: number;
  portalsRunToday: number;
  runningJobs: number;
};

type AutomationJobRow = typeof automationJobs.$inferSelect;

function getMetadataString(metadata: Record<string, unknown>, key: string, fallback = "unknown"): string {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function isScrapeJobDbConnectionError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message.toLowerCase() : "";

  return (
    isRetryableDbError(error) ||
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "57P01"].includes(code) ||
    message.includes("connection timeout") ||
    message.includes("connection terminated") ||
    message.includes("terminating connection") ||
    cause.includes("connection terminated") ||
    cause.includes("connection timeout")
  );
}

function mapPersistentScrapeJob(
  row: AutomationJobRow,
  logs: string[],
  artifacts: PersistentScrapeJobArtifact[],
): PersistentScrapeJob {
  const metadata = row.metadataJson ?? {};
  return {
    jobId: row.jobId,
    userId: row.userId,
    workflowId: row.workflowId,
    portalId: row.portalId,
    status: row.status as PersistentScrapeJobStatus,
    currentCompleted: row.currentCompleted,
    totalRows: row.totalItems,
    claimFileName: row.primaryInputFileName,
    loginFileName: row.credentialFileName,
    createdByUserId: getMetadataString(metadata, "createdByUserId", row.userId || "unknown"),
    createdByEmail: getMetadataString(metadata, "createdByEmail"),
    createdByName: getMetadataString(metadata, "createdByName"),
    startedAt: getMetadataString(metadata, "startedAt", row.createdAt || "") || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    logs,
    artifacts,
  };
}

async function hydrateScrapeJob(row: AutomationJobRow): Promise<PersistentScrapeJob> {
  const [logs, artifacts] = await Promise.all([
    getScrapeJobLogs(row.jobId),
    getScrapeJobArtifacts(row.jobId),
  ]);
  return mapPersistentScrapeJob(row, logs, artifacts);
}

export async function createPersistentScrapeJob(params: {
  jobId: string;
  userId: string;
  portalId: string;
  claimFileName?: string;
  loginFileName?: string;
  totalRows?: number;
  currentCompleted?: number;
  createdByUserId?: string;
  createdByEmail?: string;
  createdByName?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const metadata = {
    source: "scrape-jobs-api",
    createdByUserId: params.createdByUserId?.trim() || params.userId || "unknown",
    createdByEmail: params.createdByEmail?.trim() || "unknown",
    createdByName: params.createdByName?.trim() || params.createdByEmail?.trim() || "unknown",
    startedAt: now,
  };
  await runDbWithRetry((db) =>
    db
      .insert(automationJobs)
      .values({
        jobId: params.jobId,
        userId: params.userId,
        workflowId: "claim-status",
        portalId: params.portalId,
        payerId: null,
        status: "running",
        currentCompleted: params.currentCompleted ?? 0,
        totalItems: params.totalRows ?? 0,
        primaryInputFileName: params.claimFileName ?? "",
        credentialFileName: params.loginFileName ?? "",
        metadataJson: metadata,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      })
      .onConflictDoUpdate({
        target: automationJobs.jobId,
        set: {
          workflowId: "claim-status",
          portalId: params.portalId,
          payerId: null,
          status: "running",
          currentCompleted: params.currentCompleted ?? 0,
          totalItems: params.totalRows ?? 0,
          primaryInputFileName: params.claimFileName ?? "",
          credentialFileName: params.loginFileName ?? "",
          metadataJson: metadata,
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
      .from(automationJobs)
      .where(
        and(
          eq(automationJobs.userId, userId),
          eq(automationJobs.workflowId, "claim-status"),
          inArray(automationJobs.status, ["running", "waiting_otp", "waiting_resume", "cancelling"]),
        ),
      )
      .orderBy(desc(automationJobs.updatedAt))
      .limit(10),
  );

  const row = rows.find((candidate) =>
    candidate.status === "running" ||
    candidate.status === "waiting_otp" ||
    candidate.status === "cancelling" ||
    (candidate.status === "waiting_resume" && (candidate.totalItems <= 0 || candidate.currentCompleted < candidate.totalItems)),
  );
  return row ? hydrateScrapeJob(row) : null;
}

export async function getScrapeJobByIdForUser(jobId: string, userId: string): Promise<PersistentScrapeJob | null> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(automationJobs)
      .where(
        and(
          eq(automationJobs.jobId, jobId),
          eq(automationJobs.userId, userId),
          eq(automationJobs.workflowId, "claim-status"),
        ),
      )
      .limit(1),
  );

  return rows[0] ? hydrateScrapeJob(rows[0]) : null;
}

export async function getScrapeJobById(jobId: string): Promise<PersistentScrapeJob | null> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(automationJobs)
      .where(eq(automationJobs.jobId, jobId))
      .limit(1),
  );

  return rows[0] ? hydrateScrapeJob(rows[0]) : null;
}

export async function listScrapeJobsForUser(userId: string, limit = 25): Promise<PersistentScrapeJob[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const rows = await runDbWithRetry((db) =>
      db
        .select()
        .from(automationJobs)
        .where(eq(automationJobs.userId, userId))
        .orderBy(desc(automationJobs.updatedAt))
        .limit(safeLimit),
  );

  return Promise.all(
    rows.map(async (row) => {
      const artifacts = await getScrapeJobArtifacts(row.jobId);
      return mapPersistentScrapeJob(row, [], artifacts);
    }),
  );
}

export async function listRunningScrapeJobs(limit = 50): Promise<PersistentScrapeJob[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(automationJobs)
      .where(inArray(automationJobs.status, ["queued", "running", "waiting_otp", "waiting_resume", "cancelling"]))
      .orderBy(desc(automationJobs.updatedAt))
      .limit(safeLimit),
  );

  return Promise.all(
    rows.map(async (row) => {
      const artifacts = await getScrapeJobArtifacts(row.jobId);
      return mapPersistentScrapeJob(row, [], artifacts);
    }),
  );
}

async function getScrapeJobLogs(jobId: string): Promise<string[]> {
  const rows = await runDbWithRetry((db) =>
    db
      .select({ message: automationJobLogs.message })
      .from(automationJobLogs)
      .where(eq(automationJobLogs.jobId, jobId))
      .orderBy(asc(automationJobLogs.id)),
  );
  return rows.map((row) => row.message);
}

async function getScrapeJobArtifacts(jobId: string): Promise<PersistentScrapeJobArtifact[]> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(automationJobArtifacts)
      .where(eq(automationJobArtifacts.jobId, jobId))
      .orderBy(asc(automationJobArtifacts.id)),
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
  await runDbWithRetry((db) =>
    db.insert(automationJobLogs).values({
      jobId,
      level: "info",
      message,
      eventName: null,
      rowIndex: null,
      metadataJson: {},
      createdAt: new Date().toISOString(),
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
  await runDbWithRetry((db) =>
    db.insert(automationJobArtifacts).values({
      jobId: params.jobId,
      rowIndex: params.rowIndex ?? null,
      artifactType: params.artifactType,
      filename: params.filename ?? null,
      mimeType: params.mimeType ?? null,
      pathOrKey: params.pathOrKey ?? null,
      metadataJson: {},
      createdAt: new Date().toISOString(),
    }),
  );
}

export async function updateScrapeJobSnapshot(params: {
  jobId: string;
  status?: PersistentScrapeJobStatus;
  currentCompleted?: number;
  totalRows?: number;
}): Promise<void> {
  const rows = await runDbWithRetry((db) =>
    db.select().from(automationJobs).where(eq(automationJobs.jobId, params.jobId)).limit(1),
  );
  const existing = rows[0];
  if (!existing) return;

  const existingStatus = existing.status as PersistentScrapeJobStatus;
  const requestedStatus = params.status ?? existingStatus;
  const blockedStatusChange =
    (existingStatus === "cancelling" && requestedStatus !== "cancelled") ||
    (existingStatus === "cancelled" && requestedStatus !== "cancelled") ||
    (existingStatus === "completed" && requestedStatus !== "completed") ||
    (existingStatus === "failed" && requestedStatus !== "failed");
  const nextStatus = blockedStatusChange ? existingStatus : requestedStatus;
  const isTerminalStatus = nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled";
  const now = new Date().toISOString();

  await runDbWithRetry((db) =>
    db
      .update(automationJobs)
      .set({
        status: nextStatus,
        currentCompleted: params.currentCompleted ?? existing.currentCompleted,
        totalItems: params.totalRows ?? existing.totalItems,
        updatedAt: now,
        finishedAt: isTerminalStatus ? now : existing.finishedAt,
      })
      .where(eq(automationJobs.jobId, params.jobId)),
  );
}

export async function getDashboardStatsForUser(userId: string, availablePortals: number): Promise<UserDashboardStats> {
  const rows = await runDbWithRetry((db) =>
    db
      .select({
        portalsRunToday: sql<number>`COALESCE(COUNT(DISTINCT ${automationJobs.portalId}) FILTER (WHERE ${automationJobs.createdAt} >= CURRENT_DATE), 0)`,
        completedClaimsToday: sql<number>`COALESCE(SUM(${automationJobs.currentCompleted}) FILTER (WHERE ${automationJobs.status} = 'completed' AND ${automationJobs.updatedAt} >= CURRENT_DATE), 0)`,
        failedJobsToday: sql<number>`COALESCE(COUNT(*) FILTER (WHERE ${automationJobs.status} = 'failed' AND ${automationJobs.updatedAt} >= CURRENT_DATE), 0)`,
        runningJobs: sql<number>`COALESCE(COUNT(*) FILTER (WHERE ${automationJobs.status} IN ('running', 'waiting_otp', 'waiting_resume', 'cancelling')), 0)`,
      })
      .from(automationJobs)
      .where(and(eq(automationJobs.userId, userId), eq(automationJobs.workflowId, "claim-status"))),
  );

  const row = rows[0];
  return {
    availablePortals,
    completedClaimsToday: Number(row?.completedClaimsToday ?? 0),
    failedJobsToday: Number(row?.failedJobsToday ?? 0),
    portalsRunToday: Number(row?.portalsRunToday ?? 0),
    runningJobs: Number(row?.runningJobs ?? 0),
  };
}
