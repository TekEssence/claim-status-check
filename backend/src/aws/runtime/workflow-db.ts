import { and, asc, desc, eq, getTableColumns, isNull, lte, or, sql } from "drizzle-orm";
import { runDbWithRetry } from "@/db";
import {
  workflowJobArtifacts,
  workflowJobCommands,
  workflowJobConnections,
  workflowJobEvents,
  workflowJobs,
} from "@/db/schema/workflow-runtime";

export type AwsWorkflowJobStatus = "preparing" | "queued" | "starting" | "running" | "waiting_otp" | "cancelling" | "completed" | "partial_success" | "failed" | "cancelled";

const protectedStatuses = new Set<AwsWorkflowJobStatus>(["cancelling", "completed", "partial_success", "failed", "cancelled"]);

// Read new integration fields from the row JSON so existing manual jobs remain
// readable until the forward migration is applied to the target database.
const workflowJobColumns = getTableColumns(workflowJobs);
const workflowJobReadColumns = {
  jobId: workflowJobColumns.jobId,
  userId: workflowJobColumns.userId,
  workflowId: workflowJobColumns.workflowId,
  portalId: workflowJobColumns.portalId,
  clientSystem: sql<string | null>`to_jsonb("workflow_jobs")->>'client_system'`.as("client_system"),
  clientExecutionId: sql<string | null>`to_jsonb("workflow_jobs")->>'client_execution_id'`.as("client_execution_id"),
  idempotencyKey: sql<string | null>`to_jsonb("workflow_jobs")->>'idempotency_key'`.as("idempotency_key"),
  status: workflowJobColumns.status,
  ecsTaskArn: workflowJobColumns.ecsTaskArn,
  inputBucket: workflowJobColumns.inputBucket,
  outputBucket: workflowJobColumns.outputBucket,
  inputPrefix: workflowJobColumns.inputPrefix,
  outputPrefix: workflowJobColumns.outputPrefix,
  claimFileName: workflowJobColumns.claimFileName,
  loginFileName: workflowJobColumns.loginFileName,
  createdByUserId: workflowJobColumns.createdByUserId,
  createdByEmail: workflowJobColumns.createdByEmail,
  createdByName: workflowJobColumns.createdByName,
  currentCompleted: workflowJobColumns.currentCompleted,
  totalRows: workflowJobColumns.totalRows,
  errorMessage: workflowJobColumns.errorMessage,
  metadata: workflowJobColumns.metadata,
  createdAt: workflowJobColumns.createdAt,
  updatedAt: workflowJobColumns.updatedAt,
  startedAt: workflowJobColumns.startedAt,
  finishedAt: workflowJobColumns.finishedAt,
};

function isProtectedStatus(status: string): boolean {
  return protectedStatuses.has(status as AwsWorkflowJobStatus);
}

export async function createWorkflowJob(params: {
  jobId: string;
  userId: string;
  workflowId: string;
  portalId: string;
  clientSystem?: string;
  clientExecutionId?: string;
  idempotencyKey?: string;
  initialStatus?: AwsWorkflowJobStatus;
  inputBucket: string;
  outputBucket: string;
  inputPrefix: string;
  outputPrefix: string;
  claimFileName?: string;
  loginFileName?: string;
  createdByUserId?: string;
  createdByEmail?: string;
  createdByName?: string;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  await runDbWithRetry((db) =>
    db.insert(workflowJobs).values({
      jobId: params.jobId,
      userId: params.userId,
      workflowId: params.workflowId,
      portalId: params.portalId,
      ...(params.clientSystem ? {
        clientSystem: params.clientSystem,
        clientExecutionId: params.clientExecutionId,
        idempotencyKey: params.idempotencyKey,
      } : {}),
      status: params.initialStatus ?? "queued",
      inputBucket: params.inputBucket,
      outputBucket: params.outputBucket,
      inputPrefix: params.inputPrefix,
      outputPrefix: params.outputPrefix,
      claimFileName: params.claimFileName ?? "",
      loginFileName: params.loginFileName ?? "",
      createdByUserId: params.createdByUserId?.trim() || params.userId || "unknown",
      createdByEmail: params.createdByEmail?.trim() || "unknown",
      createdByName: params.createdByName?.trim() || "unknown",
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }),
  );
}

export async function getWorkflowJobByClientKey(clientSystem: string, idempotencyKey: string) {
  const rows = await runDbWithRetry((db) =>
    db.select(workflowJobReadColumns).from(workflowJobs).where(and(eq(workflowJobs.clientSystem, clientSystem), eq(workflowJobs.idempotencyKey, idempotencyKey))).limit(1),
  );
  return rows[0] ?? null;
}

export async function claimWorkflowJobLaunch(jobId: string): Promise<boolean> {
  const rows = await runDbWithRetry((db) =>
    db.update(workflowJobs).set({ status: "starting", updatedAt: new Date().toISOString() })
      .where(and(eq(workflowJobs.jobId, jobId), eq(workflowJobs.status, "queued")))
      .returning({ jobId: workflowJobs.jobId }),
  );
  return rows.length === 1;
}

export async function markWorkflowJobReady(jobId: string): Promise<boolean> {
  const rows = await runDbWithRetry((db) =>
    db.update(workflowJobs).set({ status: "queued", updatedAt: new Date().toISOString() })
      .where(and(eq(workflowJobs.jobId, jobId), eq(workflowJobs.status, "preparing")))
      .returning({ jobId: workflowJobs.jobId }),
  );
  return rows.length === 1;
}

export async function cancelUnstartedServiceJob(jobId: string, clientSystem: string): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await runDbWithRetry((db) => db.update(workflowJobs)
    .set({ status: "cancelled", updatedAt: now, finishedAt: now })
    .where(and(eq(workflowJobs.jobId, jobId), eq(workflowJobs.clientSystem, clientSystem),
      or(eq(workflowJobs.status, "preparing"), eq(workflowJobs.status, "queued"))))
    .returning({ jobId: workflowJobs.jobId }));
  return rows.length === 1;
}

export async function requestServiceJobCancellation(jobId: string, clientSystem: string): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await runDbWithRetry((db) => db.update(workflowJobs)
    .set({
      status: "cancelling", updatedAt: now,
      metadata: sql`${workflowJobs.metadata} || ${JSON.stringify({ serviceCancellationRequestedAt: now })}::jsonb`,
    })
    .where(and(eq(workflowJobs.jobId, jobId), eq(workflowJobs.clientSystem, clientSystem),
      or(eq(workflowJobs.status, "starting"), eq(workflowJobs.status, "running"), eq(workflowJobs.status, "waiting_otp"))))
    .returning({ jobId: workflowJobs.jobId }));
  return rows.length === 1;
}

export async function confirmUnstartedServiceCancellation(jobId: string, requestedBefore: string): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await runDbWithRetry((db) => db.update(workflowJobs)
    .set({ status: "cancelled", updatedAt: now, finishedAt: now })
    .where(and(eq(workflowJobs.jobId, jobId), eq(workflowJobs.status, "cancelling"),
      isNull(workflowJobs.ecsTaskArn),
      sql`(${workflowJobs.metadata}->>'serviceCancellationRequestedAt')::timestamptz <= ${requestedBefore}::timestamptz`))
    .returning({ jobId: workflowJobs.jobId }));
  return rows.length === 1;
}

export async function getWorkflowJobForUser(jobId: string, userId: string) {
  const rows = await runDbWithRetry((db) =>
    db.select(workflowJobReadColumns).from(workflowJobs).where(and(eq(workflowJobs.jobId, jobId), eq(workflowJobs.userId, userId))).limit(1),
  );
  return rows[0] ?? null;
}

export async function getWorkflowJobById(jobId: string) {
  const rows = await runDbWithRetry((db) =>
    db.select(workflowJobReadColumns).from(workflowJobs).where(eq(workflowJobs.jobId, jobId)).limit(1),
  );
  return rows[0] ?? null;
}

export async function getActiveWorkflowJobForUser(userId: string) {
  const rows = await runDbWithRetry((db) =>
    db
      .select(workflowJobReadColumns)
      .from(workflowJobs)
      .where(
        and(
          eq(workflowJobs.userId, userId),
          or(
            eq(workflowJobs.status, "queued"),
            eq(workflowJobs.status, "preparing"),
            eq(workflowJobs.status, "starting"),
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
      .select(workflowJobReadColumns)
      .from(workflowJobs)
      .where(eq(workflowJobs.userId, userId))
      .orderBy(desc(workflowJobs.updatedAt))
      .limit(safeLimit),
  );
}

export async function listRunningWorkflowJobs(limit = 50) {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  return runDbWithRetry((db) =>
    db
      .select(workflowJobReadColumns)
      .from(workflowJobs)
      .where(or(eq(workflowJobs.status, "preparing"), eq(workflowJobs.status, "queued"), eq(workflowJobs.status, "starting"), eq(workflowJobs.status, "running"), eq(workflowJobs.status, "waiting_otp"), eq(workflowJobs.status, "cancelling")))
      .orderBy(desc(workflowJobs.updatedAt))
      .limit(safeLimit),
  );
}

export async function listWatchdogWorkflowJobs(limit = 100) {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  return runDbWithRetry((db) =>
    db
      .select(workflowJobReadColumns)
      .from(workflowJobs)
      .where(or(eq(workflowJobs.status, "preparing"), eq(workflowJobs.status, "queued"), eq(workflowJobs.status, "starting"), eq(workflowJobs.status, "running"), eq(workflowJobs.status, "waiting_otp"), eq(workflowJobs.status, "cancelling")))
      .orderBy(asc(workflowJobs.updatedAt))
      .limit(safeLimit),
  );
}

export async function updateWorkflowJobMetadata(jobId: string, metadata: Record<string, unknown>) {
  await runDbWithRetry((db) =>
    db
      .update(workflowJobs)
      .set({
        metadata: sql`${workflowJobs.metadata} || ${JSON.stringify(metadata)}::jsonb`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(workflowJobs.jobId, jobId)),
  );
}

export async function updateWorkflowJob(params: {
  jobId: string;
  status?: AwsWorkflowJobStatus;
  ecsTaskArn?: string;
  currentCompleted?: number;
  totalRows?: number;
  errorMessage?: string;
  startedAt?: string;
}) {
  const now = new Date().toISOString();
  const status = params.status;
  const terminal = status === "completed" || status === "partial_success" || status === "failed" || status === "cancelled";
  const values: Partial<typeof workflowJobs.$inferInsert> = { updatedAt: now };

  const existingRows = await runDbWithRetry((db) =>
    db
      .select({
        status: workflowJobs.status,
        currentCompleted: workflowJobs.currentCompleted,
      })
      .from(workflowJobs)
      .where(eq(workflowJobs.jobId, params.jobId))
      .limit(1),
  );
  const existingStatus = existingRows[0]?.status ?? "";
  const existingCompleted = existingRows[0]?.currentCompleted ?? 0;
  const allowStatusUpdate = params.status !== undefined
    && !(existingStatus === "cancelling" && params.status !== "cancelled")
    && !(existingStatus === "completed" && params.status !== "completed")
    && !(existingStatus === "partial_success" && params.status !== "partial_success")
    && !(existingStatus === "failed" && params.status !== "failed")
    && !(existingStatus === "cancelled" && params.status !== "cancelled")
    && !(isProtectedStatus(existingStatus) && params.status === "running");

  if (allowStatusUpdate) values.status = params.status;
  if (params.ecsTaskArn !== undefined) values.ecsTaskArn = params.ecsTaskArn;
  if (params.currentCompleted !== undefined) values.currentCompleted = Math.max(existingCompleted, params.currentCompleted);
  if (params.totalRows !== undefined) values.totalRows = params.totalRows;
  if (params.errorMessage !== undefined) values.errorMessage = params.errorMessage;
  if (params.startedAt !== undefined) values.startedAt = params.startedAt;
  if (terminal && allowStatusUpdate) values.finishedAt = now;
  await runDbWithRetry((db) =>
    db
      .update(workflowJobs)
      .set(values)
      .where(and(eq(workflowJobs.jobId, params.jobId), eq(workflowJobs.status, existingStatus))),
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

export async function getLatestWorkflowInputRequest(jobId: string) {
  const rows = await runDbWithRetry((db) =>
    db.select().from(workflowJobEvents)
      .where(and(eq(workflowJobEvents.jobId, jobId), eq(workflowJobEvents.eventType, "input_request")))
      .orderBy(desc(workflowJobEvents.id)).limit(1),
  );
  return rows[0] ?? null;
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
    expiresAt: params.ttlMs && params.ttlMs > 0
      ? new Date(now.getTime() + params.ttlMs).toISOString()
      : null,
    consumedAt: null,
    createdBy: params.createdBy,
    requestedBy: params.createdBy,
    createdAt: now.toISOString(),
  };

  await runDbWithRetry((db) =>
    db.insert(workflowJobCommands).values(values),
  );
}

export async function consumePendingWorkflowCommands(jobId: string) {
  const now = new Date().toISOString();
  await runDbWithRetry((db) =>
    db.update(workflowJobCommands).set({ status: "expired", payload: {} })
      .where(and(eq(workflowJobCommands.jobId, jobId), eq(workflowJobCommands.status, "pending"), lte(workflowJobCommands.expiresAt, now))),
  );
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

  const consumed: typeof commands = [];
  for (const command of commands) {
    const claimed = await runDbWithRetry((db) =>
      db
        .update(workflowJobCommands)
        .set({
          status: "consumed",
          consumedAt: now,
          payload: {},
        })
        .where(and(eq(workflowJobCommands.id, command.id), eq(workflowJobCommands.status, "pending")))
        .returning({ id: workflowJobCommands.id }),
    );
    if (claimed.length === 1) consumed.push(command);
  }

  return consumed;
}

export async function expirePendingWorkflowCommands(): Promise<void> {
  await runDbWithRetry((db) =>
    db.update(workflowJobCommands).set({ status: "expired", payload: {} })
      .where(and(eq(workflowJobCommands.status, "pending"), lte(workflowJobCommands.expiresAt, new Date().toISOString()))),
  );
}

export async function registerConnection(params: { connectionId: string; userId: string; jobId?: string }) {
  const now = new Date().toISOString();
  await runDbWithRetry(async (db) => {
    const result = await db.execute<{ column_name: string }>(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'workflow_job_connections'
    `);
    const columns = new Set(result.rows.map((row) => row.column_name));
    const insertColumns = ["connection_id", "user_id", "job_id"];
    const insertValues = [
      sql`${params.connectionId}`,
      sql`${params.userId}`,
      sql`${params.jobId ?? null}`,
    ];
    const updateSet = [
      sql`"user_id" = ${params.userId}`,
      sql`"job_id" = ${params.jobId ?? null}`,
    ];

    if (columns.has("created_at")) {
      insertColumns.push("created_at");
      insertValues.push(sql`${now}`);
    }
    if (columns.has("updated_at")) {
      insertColumns.push("updated_at");
      insertValues.push(sql`${now}`);
      updateSet.push(sql`"updated_at" = ${now}`);
    }
    if (columns.has("connected_at")) {
      insertColumns.push("connected_at");
      insertValues.push(sql`${now}`);
    }
    if (columns.has("last_seen_at")) {
      insertColumns.push("last_seen_at");
      insertValues.push(sql`${now}`);
      updateSet.push(sql`"last_seen_at" = ${now}`);
    }

    await db.execute(sql`
      INSERT INTO "workflow_job_connections" (${sql.raw(insertColumns.map((column) => `"${column}"`).join(", "))})
      VALUES (${sql.join(insertValues, sql`, `)})
      ON CONFLICT ("connection_id") DO UPDATE SET ${sql.join(updateSet, sql`, `)}
    `);
  });
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

export async function listRecentOutputArtifactsForJob(jobId: string, limit = 10) {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  return runDbWithRetry((db) =>
    db
      .select({
        id: workflowJobArtifacts.id,
        rowIndex: workflowJobArtifacts.rowIndex,
        artifactType: workflowJobArtifacts.artifactType,
        filename: workflowJobArtifacts.filename,
        mimeType: workflowJobArtifacts.mimeType,
        createdAt: workflowJobArtifacts.createdAt,
      })
      .from(workflowJobArtifacts)
      .where(
        and(
          eq(workflowJobArtifacts.jobId, jobId),
          or(
            eq(workflowJobArtifacts.artifactType, "file_download"),
            eq(workflowJobArtifacts.artifactType, "output_snapshot"),
            eq(workflowJobArtifacts.artifactType, "pdf_download"),
          ),
        ),
      )
      .orderBy(desc(workflowJobArtifacts.id))
      .limit(safeLimit),
  );
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
