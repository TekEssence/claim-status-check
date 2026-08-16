import { bigserial, index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const workflowJobs = pgTable(
  "workflow_jobs",
  {
    jobId: varchar("job_id", { length: 100 }).primaryKey(),
    userId: varchar("user_id", { length: 100 }).notNull(),
    workflowId: varchar("workflow_id", { length: 80 }).notNull(),
    portalId: varchar("portal_id", { length: 80 }).notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    ecsTaskArn: text("ecs_task_arn"),
    inputBucket: text("input_bucket"),
    outputBucket: text("output_bucket"),
    inputPrefix: text("input_prefix"),
    outputPrefix: text("output_prefix"),
    claimFileName: text("claim_file_name").notNull().default(""),
    loginFileName: text("login_file_name").notNull().default(""),
    createdByUserId: varchar("created_by_user_id", { length: 100 }).notNull().default("unknown"),
    createdByEmail: text("created_by_email").notNull().default("unknown"),
    createdByName: text("created_by_name").notNull().default("unknown"),
    currentCompleted: integer("current_completed").notNull().default(0),
    totalRows: integer("total_rows").notNull().default(0),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (table) => ({
    userStatusUpdatedIdx: index("workflow_jobs_user_status_updated_idx").on(table.userId, table.status, table.updatedAt),
  }),
);

export const workflowJobEvents = pgTable(
  "workflow_job_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: varchar("job_id", { length: 100 }).notNull(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => ({
    jobIdIdx: index("workflow_job_events_job_id_idx").on(table.jobId, table.id),
  }),
);

export const workflowJobCommands = pgTable(
  "workflow_job_commands",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: varchar("job_id", { length: 100 }).notNull(),
    commandType: varchar("command_type", { length: 80 }).notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
    createdBy: varchar("created_by", { length: 100 }).notNull().default(""),
    requestedBy: varchar("requested_by", { length: 100 }).notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => ({
    jobCommandIdx: index("workflow_job_commands_job_command_idx").on(table.jobId, table.commandType, table.status),
  }),
);

export const workflowJobConnections = pgTable(
  "workflow_job_connections",
  {
    connectionId: varchar("connection_id", { length: 200 }).primaryKey(),
    userId: varchar("user_id", { length: 100 }).notNull(),
    jobId: varchar("job_id", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => ({
    userJobIdx: index("workflow_job_connections_user_job_idx").on(table.userId, table.jobId),
  }),
);

export const workflowJobArtifacts = pgTable(
  "workflow_job_artifacts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: varchar("job_id", { length: 100 }).notNull(),
    artifactType: varchar("artifact_type", { length: 80 }).notNull(),
    filename: text().notNull(),
    s3Bucket: text("s3_bucket").notNull(),
    bucket: text("bucket"),
    s3Key: text("s3_key").notNull(),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    rowIndex: integer("row_index"),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => ({
    jobIdIdx: index("workflow_job_artifacts_job_id_idx").on(table.jobId, table.id),
  }),
);
