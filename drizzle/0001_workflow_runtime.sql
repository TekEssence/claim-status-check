CREATE TABLE IF NOT EXISTS "workflow_jobs" (
  "job_id" varchar(100) PRIMARY KEY NOT NULL,
  "user_id" varchar(100) NOT NULL,
  "workflow_id" varchar(80) NOT NULL,
  "portal_id" varchar(80) NOT NULL,
  "status" varchar(40) NOT NULL,
  "ecs_task_arn" text,
  "input_bucket" text,
  "output_bucket" text,
  "input_prefix" text,
  "output_prefix" text,
  "claim_file_name" text DEFAULT '' NOT NULL,
  "login_file_name" text DEFAULT '' NOT NULL,
  "current_completed" integer DEFAULT 0 NOT NULL,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "error_message" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "workflow_job_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "job_id" varchar(100) NOT NULL,
  "event_type" varchar(80) NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "workflow_job_commands" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "job_id" varchar(100) NOT NULL,
  "command_type" varchar(80) NOT NULL,
  "status" varchar(40) NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "created_by" varchar(100) DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "workflow_job_connections" (
  "connection_id" varchar(200) PRIMARY KEY NOT NULL,
  "user_id" varchar(100) NOT NULL,
  "job_id" varchar(100),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "workflow_job_artifacts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "job_id" varchar(100) NOT NULL,
  "artifact_type" varchar(80) NOT NULL,
  "filename" text NOT NULL,
  "bucket" text NOT NULL,
  "s3_key" text NOT NULL,
  "mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);

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
