import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { runDbWithRetry } from "@/db";
import {
  automationJobArtifacts,
  automationJobLogs,
  automationJobs,
} from "@/db/schema/automation-jobs";
import type { WorkflowId } from "@/backend/src/workflows/types";

export type AutomationJobStatus =
  | "running"
  | "waiting_resume"
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
  const [logs, artifacts] = await Promise.all([
    runDbWithRetry((db) =>
      db
        .select()
        .from(automationJobLogs)
        .where(eq(automationJobLogs.jobId, row.jobId))
        .orderBy(asc(automationJobLogs.id)),
    ),
    runDbWithRetry((db) =>
      db
        .select()
        .from(automationJobArtifacts)
        .where(eq(automationJobArtifacts.jobId, row.jobId))
        .orderBy(asc(automationJobArtifacts.id)),
    ),
  ]);

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
    logs: logs.map((log) => ({
      level: log.level,
      message: log.message,
      eventName: log.eventName,
      rowIndex: log.rowIndex,
      metadata: log.metadataJson,
      createdAt: log.createdAt,
    })),
    artifacts: artifacts.map((artifact) => ({
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
}): Promise<void> {
  const now = new Date().toISOString();
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
      metadataJson: params.metadata ?? {},
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
          inArray(automationJobs.status, ["running", "waiting_resume"]),
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

export async function appendAutomationJobLog(params: {
  jobId: string;
  level?: string;
  message: string;
  eventName?: string;
  rowIndex?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await runDbWithRetry((db) =>
    db.insert(automationJobLogs).values({
      jobId: params.jobId,
      level: params.level ?? "info",
      message: params.message,
      eventName: params.eventName ?? null,
      rowIndex: params.rowIndex ?? null,
      metadataJson: params.metadata ?? {},
      createdAt: new Date().toISOString(),
    }),
  );
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
  await runDbWithRetry((db) =>
    db.insert(automationJobArtifacts).values({
      jobId: params.jobId,
      rowIndex: params.rowIndex ?? null,
      artifactType: params.artifactType,
      filename: params.filename ?? null,
      mimeType: params.mimeType ?? null,
      pathOrKey: params.pathOrKey ?? null,
      metadataJson: params.metadata ?? {},
      createdAt: new Date().toISOString(),
    }),
  );
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

  const status = params.status ?? (current.status as AutomationJobStatus);
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
