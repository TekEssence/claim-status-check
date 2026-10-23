ALTER TABLE "workflow_jobs" ADD COLUMN IF NOT EXISTS "client_system" varchar(80);
ALTER TABLE "workflow_jobs" ADD COLUMN IF NOT EXISTS "client_execution_id" varchar(160);
ALTER TABLE "workflow_jobs" ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(160);
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_jobs_client_idempotency_idx"
  ON "workflow_jobs" ("client_system", "idempotency_key");
