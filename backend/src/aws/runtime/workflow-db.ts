import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { runDbWithRetry } from "@/db";
import {
  workflowJobArtifacts,
  workflowJobCommands,
  workflowJobConnections,
  workflowJobEvents,
  workflowJobs,
} from "@/db/schema/workflow-runtime";

export type AwsWorkflowJobStatus = "queued" | "running" | "waiting_otp" | "completed" | "failed" | "cancelled";

export async function createWorkflowJob(params: {
  jobId: string;
  userId: string;
  workflowId: string;
  portalId: string;
  inputBucket: string;
  outputBucket: string;
  inputPrefix: string;
  outputPrefix: string;
  claimFileName?: string;
  loginFileName?: string;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  await runDbWithRetry((db) =>
    db.insert(workflowJobs).values({
      jobId: params.jobId,
      userId: params.userId,
      workflowId: params.workflowId,
      portalId: params.portalId,
      status: "queued",
      inputBucket: params.inputBucket,
      outputBucket: params.outputBucket,
      inputPrefix: params.inputPrefix,
      outputPrefix: params.outputPrefix,
      claimFileName: params.claimFileName ?? "",
      loginFileName: params.loginFileName ?? "",
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }),
  );
}

export async function getWorkflowJobForUser(jobId: string, userId: string) {
  const rows = await runDbWithRetry((db) =>
    db.select().from(workflowJobs).where(and(eq(workflowJobs.jobId, jobId), eq(workflowJobs.userId, userId))).limit(1),
  );
  return rows[0] ?? null;
}

export async function getActiveWorkflowJobForUser(userId: string) {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(workflowJobs)
      .where(
        and(
          eq(workflowJobs.userId, userId),
          or(
            eq(workflowJobs.status, "queued"),
            eq(workflowJobs.status, "running"),
            eq(workflowJobs.status, "waiting_otp"),
          ),
        ),
      )
      .orderBy(desc(workflowJobs.updatedAt))
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listWorkflowJobsForUser(userId: string, limit = 25) {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  return runDbWithRetry((db) =>
    db
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.userId, userId))
      .orderBy(desc(workflowJobs.updatedAt))
      .limit(safeLimit),
  );
}

export async function updateWorkflowJob(params: {
  jobId: string;
  status?: AwsWorkflowJobStatus;
  ecsTaskArn?: string;
  currentCompleted?: number;
  totalRows?: number;
  errorMessage?: string;
}) {
  const now = new Date().toISOString();
  const status = params.status;
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  const values: Partial<typeof workflowJobs.$inferInsert> = { updatedAt: now };
  if (params.status !== undefined) values.status = params.status;
  if (params.ecsTaskArn !== undefined) values.ecsTaskArn = params.ecsTaskArn;
  if (params.currentCompleted !== undefined) values.currentCompleted = params.currentCompleted;
  if (params.totalRows !== undefined) values.totalRows = params.totalRows;
  if (params.errorMessage !== undefined) values.errorMessage = params.errorMessage;
  if (terminal) values.finishedAt = now;
  await runDbWithRetry((db) =>
    db
      .update(workflowJobs)
      .set(values)
      .where(eq(workflowJobs.jobId, params.jobId)),
  );
}

export async function appendWorkflowEvent(jobId: string, eventType: string, payload: Record<string, unknown>) {
  const rows = await runDbWithRetry((db) =>
    db.insert(workflowJobEvents).values({
      jobId,
      eventType,
      payload,
      createdAt: new Date().toISOString(),
    }).returning({ id: workflowJobEvents.id }),
  );
  return rows[0]?.id ?? null;
}

export async function listWorkflowEvents(jobId: string, afterId = 0) {
  return runDbWithRetry((db) =>
    db
      .select()
      .from(workflowJobEvents)
      .where(and(eq(workflowJobEvents.jobId, jobId), sql`${workflowJobEvents.id} > ${afterId}`))
      .orderBy(asc(workflowJobEvents.id))
      .limit(500),
  );
}

export async function createWorkflowCommand(params: {
  jobId: string;
  commandType: string;
  payload?: Record<string, unknown>;
  createdBy: string;
  ttlMs?: number;
}) {
  const now = new Date();
  const values: typeof workflowJobCommands.$inferInsert = {
    jobId: params.jobId,
    commandType: params.commandType,
    status: "pending",
    payload: params.payload ?? {},
    createdBy: params.createdBy,
    createdAt: now.toISOString(),
  };
  if (params.ttlMs) {
    values.expiresAt = new Date(now.getTime() + params.ttlMs).toISOString();
  }

  await runDbWithRetry((db) =>
    db.insert(workflowJobCommands).values(values),
  );
}

export async function consumePendingWorkflowCommands(jobId: string) {
  const now = new Date().toISOString();
  const commands = await runDbWithRetry((db) =>
    db
      .select()
      .from(workflowJobCommands)
      .where(
        and(
          eq(workflowJobCommands.jobId, jobId),
          eq(workflowJobCommands.status, "pending"),
          or(isNull(workflowJobCommands.expiresAt), sql`${workflowJobCommands.expiresAt} > ${now}`),
        ),
      )
      .orderBy(asc(workflowJobCommands.id))
      .limit(20),
  );

  for (const command of commands) {
    await runDbWithRetry((db) =>
      db
        .update(workflowJobCommands)
        .set({
          status: "consumed",
          consumedAt: now,
        })
        .where(eq(workflowJobCommands.id, command.id)),
    );
  }

  return commands;
}

export async function registerConnection(params: { connectionId: string; userId: string; jobId?: string }) {
  const now = new Date().toISOString();
  await runDbWithRetry((db) =>
    db.insert(workflowJobConnections).values({
      connectionId: params.connectionId,
      userId: params.userId,
      jobId: params.jobId ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: workflowJobConnections.connectionId,
      set: {
        userId: params.userId,
        jobId: params.jobId ?? null,
        updatedAt: now,
      },
    }),
  );
}

export async function removeConnection(connectionId: string) {
  await runDbWithRetry((db) =>
    db.delete(workflowJobConnections).where(eq(workflowJobConnections.connectionId, connectionId)),
  );
}

export async function listConnectionsForJob(jobId: string) {
  return runDbWithRetry((db) =>
    db.select().from(workflowJobConnections).where(eq(workflowJobConnections.jobId, jobId)),
  );
}

export async function listArtifactsForJob(jobId: string) {
  const rows = await runDbWithRetry((db) =>
    db.select().from(workflowJobArtifacts).where(eq(workflowJobArtifacts.jobId, jobId)).orderBy(desc(workflowJobArtifacts.id)),
  );
  return rows.map((row) => ({
    ...row,
    bucket: row.bucket || row.s3Bucket,
  }));
}

export async function appendWorkflowArtifact(params: {
  jobId: string;
  artifactType: string;
  filename: string;
  bucket: string;
  s3Key: string;
  mimeType?: string;
}) {
  await runDbWithRetry((db) =>
    db.insert(workflowJobArtifacts).values({
      jobId: params.jobId,
      artifactType: params.artifactType,
      filename: params.filename,
      s3Bucket: params.bucket,
      bucket: params.bucket,
      s3Key: params.s3Key,
      mimeType: params.mimeType ?? "application/octet-stream",
      metadataJson: {},
      metadata: {},
      createdAt: new Date().toISOString(),
    }),
  );
}
