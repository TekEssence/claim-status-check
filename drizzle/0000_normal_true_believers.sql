CREATE TABLE "automation_job_artifacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" varchar(100) NOT NULL,
	"row_index" integer,
	"artifact_type" varchar(50) NOT NULL,
	"filename" text,
	"mime_type" text,
	"path_or_key" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_job_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" varchar(100) NOT NULL,
	"level" varchar(20) DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"event_name" varchar(100),
	"row_index" integer,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_jobs" (
	"job_id" varchar(100) PRIMARY KEY NOT NULL,
	"user_id" varchar(100) NOT NULL,
	"workflow_id" varchar(60) NOT NULL,
	"portal_id" varchar(60) NOT NULL,
	"payer_id" varchar(100),
	"status" varchar(30) NOT NULL,
	"current_completed" integer DEFAULT 0 NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"primary_input_file_name" text DEFAULT '' NOT NULL,
	"credential_file_name" text DEFAULT '' NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "automation_job_artifacts_job_id_idx" ON "automation_job_artifacts" USING btree ("job_id","id");
--> statement-breakpoint
CREATE INDEX "automation_job_logs_job_id_idx" ON "automation_job_logs" USING btree ("job_id","id");
--> statement-breakpoint
CREATE INDEX "automation_jobs_user_status_idx" ON "automation_jobs" USING btree ("user_id","status","updated_at");
--> statement-breakpoint
CREATE INDEX "automation_jobs_workflow_portal_idx" ON "automation_jobs" USING btree ("workflow_id","portal_id","payer_id");
