# Claim Status service integration (Phase 1)

The original setup examples below are historical. The current shared cursor,
progress and deployment contract is documented in
[result publication](claim-status-result-publication.md).

This is an additional backend-to-backend path. The existing browser upload, Cognito job API, WebSocket, Excel output, and download paths remain available. Claim Status does not connect to a client application's database.

## Supported workflow and setup

Phase 1 accepts `workflow: "CLAIM_STATUS"` and `portal: "iehp"`. Other portals return HTTP 422 until they have an AWS worker output and a row normalizer. The client backend must use HTTPS and provide:

- `X-Client-System: AR_WORKFLOW` (or another registered uppercase client ID)
- `Authorization: Bearer <service token>`
- `Content-Type: application/json` for POST requests

Configure `CLAIM_STATUS_SERVICE_TOKENS_JSON` as a JSON object such as `{"AR_WORKFLOW":"<random token of at least 32 characters>"}` in the deployment environment. Provision and rotate tokens outside source control. The API fails closed with 503 when this variable is absent. API Gateway exposes the service routes, and each route checks the token and job ownership. The existing worker/S3/database settings are also required: `DATABASE_URL`, `WORKFLOW_INPUTS_BUCKET`, `WORKFLOW_OUTPUTS_BUCKET`, `WORKER_CLUSTER_ARN`, `WORKER_TASK_DEFINITION_ARN`, `WORKER_SUBNET_IDS`, and optional `WORKER_SECURITY_GROUP_IDS`. The SST configuration supplies these to deployed functions.

Phase 1 accepts inline IEHP login credentials to match the existing worker. The password goes into an S3 encrypted login workbook for the worker; it does not go into job metadata, events, or the result response. Restrict and retain the inputs bucket appropriately. Moving these credentials to a secret reference requires a later contract/worker change.

## Submit

`POST /service/jobs`

```json
{
  "client_system": "AR_WORKFLOW",
  "client_execution_id": "run-2026-10-21-001",
  "idempotency_key": "run-2026-10-21-001-iehp",
  "deadline_at": "2026-10-21T18:00:00Z",
  "workflow": "CLAIM_STATUS",
  "portal": "iehp",
  "credentials": {
    "login_url": "https://example.invalid/login",
    "username": "portal-user",
    "password": "portal-password",
    "claim_status_url": "https://example.invalid/claims"
  },
  "claims": [
    {
      "client_row_ref": "opaque-row-1",
      "data": {
        "Member Policy ID": "member-123",
        "Date Of Service": "10/21/2026",
        "Claim No": "claim-456"
      }
    }
  ]
}
```

`credentials.login_url`, `credentials.username`, and `credentials.password` are required nonempty strings. `credentials.claim_status_url` is optional. Each claim needs a unique opaque `client_row_ref` (at most 160 characters), `Member Policy ID`, and `Date Of Service`; other scalar IEHP claim columns are optional. Submit 1–1000 rows per request; API Gateway request size limits still apply. Dates and prepared values must match what the IEHP portal accepts. The client owns the mapping from `client_row_ref` to its own rows and its own database updates. `deadline_at` is required, must include a timezone, and must be between one minute and seven days in the future at first submission.

The first accepted submission returns HTTP 202 with `{ "job_id": "...", "status": "RUNNING", "existing": false }` (the observed status can already be terminal). Repeating the same `client_system` and `idempotency_key` with the same request returns HTTP 200 with the same `job_id` and `existing: true`, even if its deadline has since passed. A different execution, deadline, or claim payload with that key returns 409. The password is excluded from the request fingerprint, so a password change needs a new key. To retry a terminal failed attempt, submit a new idempotency key, a new future deadline, and preferably a new `client_execution_id`. The client should save `job_id` and poll after network timeouts; it should not create another key just because the submit response was lost.

The service generates the IEHP claim workbook, login workbook, and correlated `claimRows.json` internally, uploads them to the existing inputs bucket, verifies each upload, then claims the job for ECS launch. The database unique index prevents duplicate logical jobs; an atomic `queued` → `starting` update prevents competing launches. ECS `clientToken` and `startedBy` use `job_id` for duplicate protection and task discovery. A failed input upload produces a FAILED job; if launch state is uncertain, the API returns the same `job_id` so the client can poll before retrying.

## Poll and results

`GET /service/jobs/{jobId}/results?cursor=0&limit=100` returns only jobs belonging to the authenticated client system. The existing singular `/result` route is an alias. Poll about every 10–15 seconds until `final: true`; active statuses include `PREPARING`, `QUEUED`, `STARTING`, `RUNNING`, `WAITING_OTP`, and `CANCELLING`. There is no Phase 1 callback; browser closure does not affect a running ECS job.

```json
{
  "client_system": "AR_WORKFLOW",
  "client_execution_id": "run-2026-10-21-001",
  "job_id": "<uuid>",
  "portal": "iehp",
  "status": "PARTIAL_SUCCESS",
  "processed": 2,
  "total": 2,
  "pending": 0,
  "unsupported": 0,
  "results": [
    { "client_row_ref": "opaque-row-1", "status": "SUCCESS", "result": { "claim_status": "Success", "claim_details": "..." }, "error_category": null, "error_message": null },
    { "client_row_ref": "opaque-row-2", "status": "NO_MATCH", "result": { "claim_status": "Failed", "claim_details": "" }, "error_category": "NO_MATCH", "error_message": "No matching claim" }
  ],
  "next_cursor": "2",
  "final": true,
  "artifact": { "bucket": "<bucket>", "object_key": "<key>", "artifact_type": "output_snapshot", "filename": "claims.xlsx", "size_bytes": 12345, "etag": "<etag>" },
  "action_required": null,
  "error_category": null,
  "error": null
}
```

`cursor` is a zero-based offset in the job's durable finalized-result publication ledger; omit it to start at zero. It is not a submitted-row position. `limit` defaults to 100 and has a maximum of 200. Use the returned decimal `next_cursor` on the next poll and continue upserting by `client_row_ref`. Every finalized reference is appended once, including claims completed after later submitted rows. A retry with the same cursor can replay the same immutable entries; advancing with `next_cursor` never returns an already consumed entry. Empty polls keep the cursor unchanged. `total` counts submitted references, `processed` counts finalized results recorded in the ledger, `pending = total - processed`, and `unsupported` counts finalized `UNSUPPORTED_PAYER` outcomes included in `processed`. Unsupported rows remain included in `total`. On terminal jobs, references without finalized output get explicit `FAILED` outcomes (`CANCELLED` or `OUTPUT_MISSING`). `final` is true only when the job is terminal, pending is zero, and the page reaches the ledger's end. Continue draining pages after a terminal status. Invalid or unavailable required workbooks return 503 for retry; a partial snapshot cannot revoke already recorded publications.

Rows have `SUCCESS`, `NO_MATCH`, `FAILED`, `ACTION_REQUIRED`, or `INCOMPLETE`, with `{client_row_ref,status,result:{claim_status,claim_details},error_category,error_message}`. A job is `SUCCESS` only if every row succeeds. At least one successful row plus other outcomes is `PARTIAL_SUCCESS`; zero successful rows is `FAILED`. The Claim Status API reads the current S3 workbook, validates the original `Client Row Ref` column against `claimRows.json`, and normalizes IEHP status/detail/error columns. The original workbook is overwritten at one stable S3 key. On claim progress, the worker uploads a snapshot at most once every 10 seconds; it also uploads on completion or caught failure. A hard ECS stop preserves the last successful snapshot. There is no separate result JSON object or per-row result DB table. For a workbook download URL, call `GET /service/jobs/{jobId}/download` with the same service headers; the returned URL is short lived.

`error_category` distinguishes authentication, portal, infrastructure, deadline, task, and output errors where the worker provides enough information. The portal may classify some failures as `PORTAL_ERROR` when its message is not specific. Apply only rows with known `client_row_ref`. A terminal failure before any workbook exists publishes explicit failed outcomes for the submitted references; if those references cannot be recovered, the poll returns 503 rather than inventing identities. The once-per-minute watchdog enforces `deadline_at`: it stops a running ECS task, waits for STOPPED, then reconciles the last S3 snapshot. With some successful rows the outcome is `PARTIAL_SUCCESS`; otherwise it is `FAILED`. The terminal error is `Execution deadline exceeded.` with `error_category: DEADLINE_EXCEEDED`, so AR Workflow can release reservations after `final: true`.

## OTP and manual action

When IEHP displays an OTP field after credentials are submitted, the worker keeps its browser session open for up to six minutes and emits an input request. The result endpoint returns `WAITING_OTP` and `action_required` with `type: "OTP_REQUIRED"`, `portal: "iehp"`, `input_name: "iehp_otp"`, a label and message, `expires_at`, a masked `account_label` when available, and `action_url: null`. Submit the code with `POST /service/jobs/{jobId}/input` and `{"input_name":"iehp_otp","value":"123456"}` while the challenge is active. The command expires after six minutes if unconsumed, and its value is cleared from the command row when consumed or expired. An IEHP OTP timeout or rejected code fails the job with a clear reason; available partial output remains subject to the existing worker reconciliation. A row that reaches an interactive failure is normalized as `ACTION_REQUIRED`.

## Database and rollout

Forward migration `drizzle/0007_service_claim_status.sql` adds nullable `client_system`, `client_execution_id`, and `idempotency_key` to `workflow_jobs` plus a unique index on `(client_system, idempotency_key)`. Nullable fields preserve manual jobs. Migration `drizzle/0008_service_result_publication.sql` additionally creates the shared `workflow_service_results` ledger. Apply it before deploying the new result API. Deadline, submitted count and fallback reference metadata remain on the existing job. See the publication report for the current rollout order.

Manual rollout later, in this order:

1. Review the migration and back up the target database.
2. Set `DATABASE_URL` (and `DB_SSL` if needed) for the target environment, then run `npm run db:migrate`. Do not run it against a database until the target is confirmed.
3. Set `CLAIM_STATUS_SERVICE_TOKENS_JSON` in the deployment environment with a strong token for each client system. Keep it out of Git and logs.
4. Deploy the application/worker through the project's normal SST deployment process (`npx sst deploy --stage dev` for the dev stage). Ensure the worker image and API version are aligned.
5. Submit one nonproduction IEHP claim from the client backend, poll the result, and verify the S3 workbook and row mapping before sending production batches.

No migration, deployment, ECS task, or payer portal was run as part of this implementation.
