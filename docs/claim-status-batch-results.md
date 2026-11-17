# AR Workflow batch results contract

Batch mode uses the existing `GET /service/jobs/{jobId}/results` route with
`jobId=batch`. No route is added. Normal job IDs retain their current single-job
response. The singular `/result` alias also accepts batch mode.

Send the existing `X-Client-System: AR_WORKFLOW` and
`Authorization: Bearer <service token>` headers.

```js
const jobs = [
  { job_id: "job-A", cursor: "0", limit: 100 },
  { job_id: "job-B", cursor: "25", limit: 100 },
];
const path = `/service/jobs/batch/results?jobs=${encodeURIComponent(JSON.stringify(jobs))}`;
```

`jobs` is a URL-encoded JSON array, not a GET body. Each entry requires a unique
`job_id` of 1–100 letters, digits, underscores or hyphens, starting with a letter
or digit. `cursor` defaults to `"0"` and must be a decimal string representing a
nonnegative JavaScript safe integer, without leading zeroes. `limit` defaults to
100 and must be an integer from 1 to 200. Store and send a separate cursor for
each job.

The response is HTTP 200 for a valid batch, including batches with per-job errors:

```json
{
  "jobs": {
    "job-A": {
      "http_status": 200,
      "client_system": "AR_WORKFLOW",
      "client_execution_id": "run-A",
      "job_id": "job-A",
      "portal": "iehp",
      "status": "RUNNING",
      "processed": 0,
      "total": 1,
      "pending": 1,
      "unsupported": 0,
      "success": 0,
      "failed": 0,
      "no_match": 0,
      "skipped": 0,
      "action_required_count": 0,
      "results": [],
      "next_cursor": "0",
      "final": false,
      "artifact": null,
      "action_required": null,
      "error_category": null,
      "error": null
    },
    "job-B": {
      "http_status": 404,
      "error": "Job not found.",
      "next_cursor": "25"
    }
  }
}
```

Successful entries use the existing single-job response fields and claim result
contract, plus `http_status`. Each result remains one `client_row_ref` outcome,
including all its `detail_rows`. A failed automation job is a successful retrieval
(`http_status: 200`, `status: "FAILED"`) with the existing error fields. Counts
describe all published outcomes, not just the current page. OTP and provider
selection fields are unchanged; submit input through the existing input route.

### Outcome counters and SKIPPED

Claim Status now returns `success`, `failed`, `no_match`, `skipped`, and
`action_required_count` on each successful single-job or batch Claim Status
response. These are job-wide claim counts, independent of the requested page.
The worker stores them in job metadata in the same transaction as the immutable
claim outcomes and completed/total counters; retries count only saved outcomes.

`SKIPPED` is a new finalized per-claim status. It means the worker deliberately
skipped the claim, for example an unsupported payer or invalid input. Its reason
is retained in `error_category`/`error_message` and full details. AR must accept
this status, apply it to that `client_row_ref`, and advance its cursor normally.
It is distinct from `FAILED` and `NO_MATCH`. A whole skipped detail group remains
one skipped claim even when accompanied by diagnostic error-sheet entries.
A mixed successful/skipped detail group is `FAILED`, not a successful claim.

`processed = success + failed + no_match + skipped + action_required_count`;
`pending = total - processed`. `unsupported` is an overlapping reason count,
usually a subset of `skipped` for new runs; never add it again to `processed`.
Historical unsupported outcomes already frozen as `FAILED` retain that status.

The existing claim-level `ACTION_REQUIRED` value remains compatible and uses
`action_required_count`. The top-level `action_required` object is the job's live
OTP/provider-selection prompt. Waiting for that input does not itself finalize
a claim or increment any claim outcome counter. Job status values are unchanged:
all-skipped jobs still have `FAILED` job status; successful plus skipped claims
produce `PARTIAL_SUCCESS`.

## Bounds and cursor behavior

- 1–10 jobs; decoded `jobs` query at most 8192 UTF-8 bytes.
- Default 100, maximum 200 outcomes requested per job.
- Maximum 500 outcomes total. For N requested jobs, each gets at most
  `min(requested limit, floor(500 / N))` outcomes; unused shares are not reassigned.
- Maximum 4 MiB serialized JSON response. Each job receives an equal byte share
  of `(4 MiB - 8192) / N`, rounded down; the reserve covers the outer envelope.
- Only complete claim outcomes are included. Byte trimming stops at a prefix;
  `next_cursor` advances only by the actual number returned. `final` remains
  false whenever results are withheld. Repeating the same cursor can replay
  frozen outcomes; a later earlier-row completion still appends normally.
- If the next entire claim or action metadata cannot fit its byte share, that
  job returns 413 with its cursor unchanged. Retrieve it through the single-job
  route (for example, with `limit=1`) or use the workbook download. Other jobs
  keep their independent shares, so large jobs cannot starve them.

## Errors and data access

Whole-request errors: invalid/missing authentication returns 401 (503 if service
authentication is unconfigured); malformed JSON, job count, duplicate/invalid
IDs or query length returns 400; an unavailable shared DB read returns 503.

Per-job errors: invalid cursor/limit returns 400; missing and foreign-owned jobs
both return 404; excessive claim/metadata size returns 413; non-Claim-Status
workflows return 422; inconsistent/unavailable recorded results return 503.
Unexpected per-job errors return a sanitized 500. Error entries retain their
valid cursor; an unparseable cursor is returned as null. Do not advance it.

One read-only SQL statement fetches the owned job rows, saved counters,
requested claim pages, and latest active input requests. Jobs written by the
updated worker use the existing `(job_id, sequence)` index with a cursor range
and per-job LIMIT; polling does not scan their earlier outcomes. Historical jobs
without saved counters retain the existing read-only count/validation fallback.
Returned-page validation and response
construction are shared with single-job reads. There are no per-job HTTP calls,
S3 reads, automation waits, job mutations or ECS reconciliation in batch mode;
status reflects the current committed database state.

Deploy the API and rebuilt worker together for SKIPPED and saved counters. No
new route, table, index or migration is needed beyond existing migration 0008.
New jobs automatically use saved counters; historical result payloads and
cursors are not rewritten or backfilled by polling. Update AR's allowed claim
statuses to include SKIPPED before adopting the new worker results.

## Cancelled jobs

Cancellation remains `CANCELLING` until launch is blocked or ECS confirms the
worker has stopped and claim results have been reconciled. Published outcomes
keep their payloads and sequences. Completed saved outputs are recovered before
any unfinished claim is appended as `status: "FAILED"`,
`error_category: "CANCELLED"`. These unfinished claims are included in `failed`
and `processed`; they do not claim that automation completed successfully.
The job response has `status: "CANCELLED"` and `error_category: "CANCELLED"`.

AR must keep paging a cancelled job until `final: true`. A terminal job status
alone does not mean all results were delivered. `final` becomes true only when
there are no pending claims and the response reaches the last published result.
For example, a cancelled 290-claim job with 147 published results can append 143
cancellation outcomes; cursor `147`, limit 100 returns 100 results, cursor `247`,
`final: false`; cursor `247` returns 43 results, cursor `290`, `final: true`.
Real recovered results replace those hypothetical cancellation outcomes where
available. Replaying a cursor remains safe.

Batch polling stays read-only. The ECS STOPPED event handler performs stopped-job
reconciliation; the watchdog retries missed events and recovery failures. Deploy the API, watchdog (including its output
bucket ListBucket permission) and worker changes together. No additional table
or migration is needed for cancellation.

Unexpected task stops now use the same delivery completion rules. Unfinished
claims receive `FAILED` with `error_category: "TASK_FAILED"` for a crash/OOM,
`"DEADLINE_EXCEEDED"` for a deadline stop, or the existing `"OUTPUT_MISSING"`
for a clean exit that did not finalize the claim. Saved outcomes are preserved.
Keep paging from the existing cursor until `final: true`, including jobs whose
status is `FAILED` or `PARTIAL_SUCCESS`. Deploy the SST STOPPED event subscription
and its handler together with these backend changes; the request contract stays
the same.
