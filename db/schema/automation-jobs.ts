import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const automationJobs = pgTable(
  "automation_jobs",
  {
    jobId: varchar("job_id", { length: 100 }).primaryKey(),
    userId: varchar("user_id", { length: 100 }).notNull(),
    workflowId: varchar("workflow_id", { length: 60 }).notNull(),
    portalId: varchar("portal_id", { length: 60 }).notNull(),
    payerId: varchar("payer_id", { length: 100 }),
    status: varchar("status", { length: 30 }).notNull(),
    currentCompleted: integer("current_completed").notNull().default(0),
    totalItems: integer("total_items").notNull().default(0),
    primaryInputFileName: text("primary_input_file_name").notNull().default(""),
    credentialFileName: text("credential_file_name").notNull().default(""),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (table) => ({
    userStatusUpdatedIdx: index("automation_jobs_user_status_idx").on(
      table.userId,
      table.status,
      table.updatedAt,
    ),
    workflowPortalIdx: index("automation_jobs_workflow_portal_idx").on(
      table.workflowId,
      table.portalId,
      table.payerId,
    ),
  }),
);

export const automationJobLogs = pgTable(
  "automation_job_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: varchar("job_id", { length: 100 }).notNull(),
    level: varchar("level", { length: 20 }).notNull().default("info"),
    message: text("message").notNull(),
    eventName: varchar("event_name", { length: 100 }),
    rowIndex: integer("row_index"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => ({
    jobIdIdx: index("automation_job_logs_job_id_idx").on(table.jobId, table.id),
  }),
);

export const automationJobArtifacts = pgTable(
  "automation_job_artifacts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: varchar("job_id", { length: 100 }).notNull(),
    rowIndex: integer("row_index"),
    artifactType: varchar("artifact_type", { length: 50 }).notNull(),
    filename: text("filename"),
    mimeType: text("mime_type"),
    pathOrKey: text("path_or_key"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => ({
    jobIdIdx: index("automation_job_artifacts_job_id_idx").on(table.jobId, table.id),
  }),
);
