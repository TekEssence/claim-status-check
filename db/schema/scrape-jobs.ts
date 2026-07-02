import { bigserial, index, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const scrapeJobs = pgTable(
  "iehp_scrape_jobs",
  {
    jobId: varchar("job_id", { length: 100 }).primaryKey(),
    userId: varchar("user_id", { length: 100 }).notNull(),
    portalId: varchar("portal_id", { length: 50 }).notNull(),
    status: varchar("status", { length: 30 }).notNull(),
    currentCompleted: integer("current_completed").notNull().default(0),
    totalRows: integer("total_rows").notNull().default(0),
    claimFileName: text("claim_file_name").notNull().default(""),
    loginFileName: text("login_file_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (table) => ({
    userStatusUpdatedIdx: index("iehp_scrape_jobs_user_status_idx").on(table.userId, table.status, table.updatedAt),
  }),
);

export const scrapeJobLogs = pgTable(
  "iehp_scrape_job_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: varchar("job_id", { length: 100 }).notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => ({
    jobIdIdx: index("iehp_scrape_job_logs_job_id_idx").on(table.jobId, table.id),
  }),
);

export const scrapeJobArtifacts = pgTable(
  "iehp_scrape_job_artifacts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: varchar("job_id", { length: 100 }).notNull(),
    rowIndex: integer("row_index"),
    artifactType: varchar("artifact_type", { length: 50 }).notNull(),
    filename: text("filename"),
    mimeType: text("mime_type"),
    pathOrKey: text("path_or_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
);
