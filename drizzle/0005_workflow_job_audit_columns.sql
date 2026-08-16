ALTER TABLE "workflow_jobs"
  ADD COLUMN IF NOT EXISTS "created_by_user_id" varchar(100),
  ADD COLUMN IF NOT EXISTS "created_by_email" text,
  ADD COLUMN IF NOT EXISTS "created_by_name" text;

UPDATE "workflow_jobs"
SET
  "created_by_user_id" = COALESCE(NULLIF("created_by_user_id", ''), NULLIF("user_id", ''), 'unknown'),
  "created_by_email" = COALESCE(NULLIF("created_by_email", ''), 'unknown'),
  "created_by_name" = COALESCE(NULLIF("created_by_name", ''), 'unknown')
WHERE
  "created_by_user_id" IS NULL
  OR "created_by_email" IS NULL
  OR "created_by_name" IS NULL
  OR "created_by_user_id" = ''
  OR "created_by_email" = ''
  OR "created_by_name" = '';

ALTER TABLE "workflow_jobs"
  ALTER COLUMN "created_by_user_id" SET DEFAULT 'unknown',
  ALTER COLUMN "created_by_user_id" SET NOT NULL,
  ALTER COLUMN "created_by_email" SET DEFAULT 'unknown',
  ALTER COLUMN "created_by_email" SET NOT NULL,
  ALTER COLUMN "created_by_name" SET DEFAULT 'unknown',
  ALTER COLUMN "created_by_name" SET NOT NULL;
