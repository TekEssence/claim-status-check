ALTER TABLE "workflow_jobs"
  ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
