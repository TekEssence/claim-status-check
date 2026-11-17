CREATE TABLE IF NOT EXISTS "workflow_service_results" (
  "job_id" varchar(100) NOT NULL REFERENCES "workflow_jobs" ("job_id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "client_row_ref" varchar(160) NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_service_results_job_ref_pk" PRIMARY KEY ("job_id", "client_row_ref"),
  CONSTRAINT "workflow_service_results_job_sequence_unique" UNIQUE ("job_id", "sequence"),
  CONSTRAINT "workflow_service_results_sequence_positive" CHECK ("sequence" > 0)
);
