# Eligibility service integration

Use the existing service routes and authentication (`X-Client-System` and a registered Bearer token).
Supported portal IDs are `availity`, `healthnet`, `iehp`, `medical`, `trizetto`, and `waystar`, with `projectId: "medrevenue"`.
UHC is supported with `portal: "uhc"` and `projectId: "minimax"` only. UHC MedRevenue submissions are rejected before launch.

## Submit and poll

`POST /service/jobs`:

```json
{
  "client_system": "AR_WORKFLOW",
  "client_execution_id": "eligibility-run-1",
  "idempotency_key": "eligibility-run-1-iehp",
  "workflow": "ELIGIBILITY",
  "portal": "iehp",
  "projectId": "medrevenue",
  "credentials": {
    "login_url": "https://example.test/login",
    "username": "account",
    "password": "password"
  },
  "claims": [{
    "client_row_ref": "ar-row-1",
    "data": {
      "Primary Insurance Name": "IEHP",
      "Patient Name": "Example, Jane",
      "Member ID": "member-id",
      "DOB": "01/02/1990",
      "DOS": "10/20/2026"
    }
  }]
}
```

Submit returns the existing `job_id`, `status`, and `existing` fields. Use the same idempotency key for submission retries.
The new portals retain their native input headers/aliases, payer filtering and credential readers. Inputs that the native reader would filter out are rejected before launch. Availity retains its existing required canonical fields and date validation.

Poll `GET /service/jobs/{jobId}/results?cursor=0&limit=100` (limit 1–200). The response keeps `client_system`, `client_execution_id`, `job_id`, `portal`, `status`, `processed`, `total`, `pending`, `unsupported`, `results`, `next_cursor`, `final`, `artifact`, `action_required`, `error_category`, and `error`.
Each result retains `client_row_ref`, `status`, `result: {coverage_status, details}`, `error_category`, and `error_message`. Coverage is canonical `active`, `inactive`, or null; native workbook values stay in `details`. Inactive coverage is a successful lookup.
Send each returned cursor unchanged on the next request. Empty results do not advance it. Final delivery requires a terminal job, no unfinished rows, and a drained cursor.
The existing batch results mode remains Claim Status only.

## Credentials and execution

Availity retains optional `totp_secret` and `success_url_fragment`. Other single-account portals use `login_url`, `username`, and `password`; their existing OTP flow uses the service `/input` route when requested.
UHC additionally requires `credentials.totp_secret` and uses its existing authenticator flow. Its claim data uses the native Member ID and DOB aliases; a payer column is optional for a dedicated UHC workbook. UHC results use the same JSON structure and retain native columns such as Network, Coinsurance, Copay, Deductible, and Out of Pocket in `result.details`.
Waystar also accepts optional `payer`, `provider_id`, `provider_name`, `service_type_code`, and `verification_answers: [{question, answer}]`. For separate payer accounts, supply `credentials: {accounts: [...]}` with 1–100 accounts (at most 25 verification answers per account). Existing Waystar credential routing must find an account for every requested payer.

Workers publish native output snapshots into the existing result ledger and update counts in the same DB transaction. Periodic snapshots are throttled to ten seconds; Medi-Cal retains its existing per-row snapshots. Final native output is also published. Normal polls read the DB without downloading workbooks or publishing results.
Cancellation, force stop and crashes reuse confirmed-stop recovery. Existing outcomes remain immutable; saved output is recovered and only unfinished rows receive cancellation/crash failure outcomes. Temporary recovery errors remain retryable. Downloads and stopped-task recovery still use S3.

## Deferred and deployment

Noridian is unchanged because it returns raw benefit text and dates without a defined active/inactive coverage mapping. It remains unsupported by service submission (422).

Deploy the worker image and backend Lambdas together. No new API routes, tables, migrations, frontend changes or SST changes are introduced by this extension. The existing result-ledger migration and service/worker AWS permissions must already be deployed.
