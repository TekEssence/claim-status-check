ALTER TABLE "workflow_job_commands"
  ADD COLUMN IF NOT EXISTS "requested_by" varchar(100);

UPDATE "workflow_job_commands"
SET "requested_by" = COALESCE("requested_by", "created_by", '')
WHERE "requested_by" IS NULL;

ALTER TABLE "workflow_job_commands"
  ALTER COLUMN "requested_by" SET DEFAULT '',
  ALTER COLUMN "requested_by" SET NOT NULL;
