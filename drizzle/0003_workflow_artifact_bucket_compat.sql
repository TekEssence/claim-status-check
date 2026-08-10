ALTER TABLE "workflow_job_artifacts"
  ADD COLUMN IF NOT EXISTS "s3_bucket" text,
  ADD COLUMN IF NOT EXISTS "row_index" integer,
  ADD COLUMN IF NOT EXISTS "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;

UPDATE "workflow_job_artifacts"
SET "s3_bucket" = COALESCE("s3_bucket", "bucket")
WHERE "s3_bucket" IS NULL;

ALTER TABLE "workflow_job_artifacts"
  ALTER COLUMN "s3_bucket" SET NOT NULL,
  ALTER COLUMN "bucket" DROP NOT NULL;
