import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { runDbWithRetry } from "@/db";
import {
  automationJobArtifacts,
  automationJobs,
} from "@/db/schema/automation-jobs";
import type { WorkflowId } from "@/backend/src/workflows/types";
import { appendLocalArtifact, expandLocalArtifacts } from "./artifacts";

export type AutomationJobStatus =
  | "running"
  | "waiting_resume"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type PersistentAutomationJob = {
  jobId: string;
  userId: string;
  workflowId: WorkflowId;
  portalId: string;
  payerId: string | null;
  status: AutomationJobStatus;
  currentCompleted: number;
  totalItems: number;
  primaryInputFileName: string;
  credentialFileName: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  logs: Array<{
    level: string;
    message: string;
    eventName: string | null;
    rowIndex: number | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
  artifacts: Array<{
    id: number;
    rowIndex: number | null;
    artifactType: string;
    filename: string;
    mimeType: string;
    pathOrKey: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
};

type AutomationJobRow = typeof automationJobs.$inferSelect;

async function hydrateJob(row: AutomationJobRow): Promise<PersistentAutomationJob> {
  const artifacts = await runDbWithRetry((db) =>
    db
      .select()
      .from(automationJobArtifacts)
      .where(eq(automationJobArtifacts.jobId, row.jobId))
      .orderBy(asc(automationJobArtifacts.id)),
  );

  return {
    jobId: row.jobId,
    userId: row.userId,
    workflowId: row.workflowId as WorkflowId,
    portalId: row.portalId,
    payerId: row.payerId,
    status: row.status as AutomationJobStatus,
    currentCompleted: row.currentCompleted,
    totalItems: row.totalItems,
    primaryInputFileName: row.primaryInputFileName,
    credentialFileName: row.credentialFileName,
    metadata: row.metadataJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    logs: [],
    artifacts: artifacts.flatMap(expandLocalArtifacts).map((artifact) => ({
      id: artifact.id,
      rowIndex: artifact.rowIndex,
      artifactType: artifact.artifactType,
      filename: artifact.filename ?? "",
      mimeType: artifact.mimeType ?? "",
      pathOrKey: artifact.pathOrKey ?? "",
      metadata: artifact.metadataJson,
      createdAt: artifact.createdAt,
    })),
  };
}

export async function createPersistentAutomationJob(params: {
  jobId: string;
  userId: string;
  workflowId: WorkflowId;
  portalId: string;
  payerId?: string;
  totalItems?: number;
  primaryInputFileName?: string;
  credentialFileName?: string;
  metadata?: Record<string, unknown>;
  createdByUserId?: string;
  createdByEmail?: string;
  createdByName?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const metadata = {
    ...(params.metadata ?? {}),
    createdByUserId: params.createdByUserId?.trim() || params.userId || "unknown",
    createdByEmail: params.createdByEmail?.trim() || "unknown",
    createdByName: params.createdByName?.trim() || params.createdByEmail?.trim() || "unknown",
    startedAt: now,
  };
  await runDbWithRetry((db) =>
    db.insert(automationJobs).values({
      jobId: params.jobId,
      userId: params.userId,
      workflowId: params.workflowId,
      portalId: params.portalId,
      payerId: params.payerId || null,
      status: "running",
      currentCompleted: 0,
      totalItems: params.totalItems ?? 0,
      primaryInputFileName: params.primaryInputFileName ?? "",
      credentialFileName: params.credentialFileName ?? "",
      metadataJson: metadata,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    }),
  );
}

export async function getActiveAutomationJobForUser(
  userId: string,
): Promise<PersistentAutomationJob | null> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(automationJobs)
      .where(
        and(
          eq(automationJobs.userId, userId),
          inArray(automationJobs.status, ["running", "waiting_resume", "cancelling"]),
        ),
      )
      .orderBy(desc(automationJobs.updatedAt))
      .limit(1),
  );
  return rows[0] ? hydrateJob(rows[0]) : null;
}

export async function getAutomationJobForUser(
  jobId: string,
  userId: string,
): Promise<PersistentAutomationJob | null> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(automationJobs)
      .where(and(eq(automationJobs.jobId, jobId), eq(automationJobs.userId, userId)))
      .limit(1),
  );
  return rows[0] ? hydrateJob(rows[0]) : null;
}

export async function listAutomationJobsForUser(
  userId: string,
  limit = 25,
): Promise<PersistentAutomationJob[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(automationJobs)
      .where(eq(automationJobs.userId, userId))
      .orderBy(desc(automationJobs.updatedAt))
      .limit(safeLimit),
  );
  return Promise.all(rows.map((row) => hydrateJob(row)));
}

export async function appendAutomationJobArtifact(params: {
  jobId: string;
  rowIndex?: number;
  artifactType: string;
  filename?: string;
  mimeType?: string;
  pathOrKey?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await appendLocalArtifact(params);
}

export async function updateAutomationJob(params: {
  jobId: string;
  status?: AutomationJobStatus;
  currentCompleted?: number;
  totalItems?: number;
}): Promise<void> {
  const rows = await runDbWithRetry((db) =>
    db.select().from(automationJobs).where(eq(automationJobs.jobId, params.jobId)).limit(1),
  );
  const current = rows[0];
  if (!current) return;

  const currentStatus = current.status as AutomationJobStatus;
  const requestedStatus = params.status ?? currentStatus;
  const blockedStatusChange =
    (currentStatus === "cancelling" && requestedStatus !== "cancelled") ||
    (currentStatus === "cancelled" && requestedStatus !== "cancelled") ||
    (currentStatus === "completed" && requestedStatus !== "completed") ||
    (currentStatus === "failed" && requestedStatus !== "failed");
  const status = blockedStatusChange ? currentStatus : requestedStatus;
  const now = new Date().toISOString();
  const terminal = ["completed", "failed", "cancelled"].includes(status);
  await runDbWithRetry((db) =>
    db
      .update(automationJobs)
      .set({
        status,
        currentCompleted: params.currentCompleted ?? current.currentCompleted,
        totalItems: params.totalItems ?? current.totalItems,
        updatedAt: now,
        finishedAt: terminal ? now : current.finishedAt,
      })
      .where(eq(automationJobs.jobId, params.jobId)),
  );
}

// List polling needs summaries only; never hydrate every job's logs/artifacts.
export async function listAutomationJobSummariesForUser(userId: string, limit = 25) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 100)) : 25;
  return runDbWithRetry((db) => db.select({
    jobId: automationJobs.jobId,
    workflowId: automationJobs.workflowId,
    portalId: automationJobs.portalId,
    payerId: automationJobs.payerId,
    status: automationJobs.status,
    currentCompleted: automationJobs.currentCompleted,
    totalItems: automationJobs.totalItems,
    primaryInputFileName: automationJobs.primaryInputFileName,
    credentialFileName: automationJobs.credentialFileName,
    createdAt: automationJobs.createdAt,
    updatedAt: automationJobs.updatedAt,
    finishedAt: automationJobs.finishedAt,
    artifactCount: sql<number>`(select count(*) from ${automationJobArtifacts} where ${automationJobArtifacts.jobId} = ${automationJobs.jobId})`.mapWith(Number),
  }).from(automationJobs)
    .where(eq(automationJobs.userId, userId))
    .orderBy(desc(automationJobs.updatedAt))
    .limit(safeLimit));
}
