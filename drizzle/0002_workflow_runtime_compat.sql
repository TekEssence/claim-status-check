ALTER TABLE "workflow_jobs"
  ADD COLUMN IF NOT EXISTS "input_prefix" text,
  ADD COLUMN IF NOT EXISTS "output_prefix" text,
  ADD COLUMN IF NOT EXISTS "claim_file_name" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "login_file_name" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "total_rows" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "error_message" text,
  ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE "workflow_job_events"
  ADD COLUMN IF NOT EXISTS "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE "workflow_job_commands"
  ADD COLUMN IF NOT EXISTS "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "created_by" varchar(100) DEFAULT '' NOT NULL;

ALTER TABLE "workflow_job_connections"
  ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;

UPDATE "workflow_job_connections"
SET
  "created_at" = COALESCE("created_at", "connected_at", now()),
  "updated_at" = COALESCE("updated_at", "last_seen_at", now())
WHERE "created_at" IS NULL OR "updated_at" IS NULL;

ALTER TABLE "workflow_job_artifacts"
  ADD COLUMN IF NOT EXISTS "bucket" text,
  ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;

UPDATE "workflow_job_artifacts"
SET "bucket" = COALESCE("bucket", "s3_bucket")
WHERE "bucket" IS NULL;

CREATE INDEX IF NOT EXISTS "workflow_jobs_user_status_updated_idx"
  ON "workflow_jobs" USING btree ("user_id", "status", "updated_at");

CREATE INDEX IF NOT EXISTS "workflow_job_events_job_id_idx"
  ON "workflow_job_events" USING btree ("job_id", "id");

CREATE INDEX IF NOT EXISTS "workflow_job_commands_job_command_idx"
  ON "workflow_job_commands" USING btree ("job_id", "command_type", "status");

CREATE INDEX IF NOT EXISTS "workflow_job_connections_user_job_idx"
  ON "workflow_job_connections" USING btree ("user_id", "job_id");

CREATE INDEX IF NOT EXISTS "workflow_job_artifacts_job_id_idx"
  ON "workflow_job_artifacts" USING btree ("job_id", "id");
