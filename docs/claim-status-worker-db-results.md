# Worker-published Claim Status results

Claim Status service workers now publish finalized claim outcomes directly to
`workflow_service_results`. In the same per-job database transaction they update
`workflow_jobs.current_completed`, `total_rows`, and output artifact metadata.
The existing job lock, immutable payloads, reference uniqueness, and cursor
sequence are reused. Progress events are sent after this transaction commits.
Other service progress callbacks cannot advance the database counters.
The same transaction now saves success, failure, no-match, skipped and existing
claim-manual-action counts, plus the unsupported-payer subset, in job metadata.
They are tallied from immutable recorded outcomes and new inserts, so duplicate
or stale worker retries cannot double-count or regress progress.

`GET /service/jobs/{jobId}/results` and its singular alias read Claim Status
results from the database without importing S3 output into the result table.
Their authentication, ownership, response fields, per-claim detail grouping,
cursor behavior, and OTP/provider selection responses are retained. Eligibility
keeps its existing result publication path. No batch endpoint is added.
Single-job and batch polling use the saved counters and indexed cursor pages
for updated-worker jobs. Historical jobs without these counters retain the
previous read-only fallback; no historical outcomes are silently reclassified.
See [the AR contract](claim-status-batch-results.md) for SKIPPED and counter fields.

Excel downloads and S3 JSON snapshots remain available. JSON is retained for
worker restart/recovery and stopped-task cancellation reconciliation, rather than
being the results API's publication source. S3 and PostgreSQL are not one
transaction: a JSON save may precede a failed DB write, but claim outcomes and
database progress always commit or roll back together. Retrying publication
does not duplicate results or advance progress without saved outcomes.

Cancellation first blocks launch or waits for ECS to confirm STOPPED. A startup
with no discoverable task uses the existing 15-minute absence confirmation and
still checks saved outputs; only a blocked launch skips recovery. The backend
then preserves published DB outcomes, recovers completed JSON/workbook outcomes
(including uploaded workbooks not yet registered as artifacts), and appends one
`FAILED` / `CANCELLED` outcome for each remaining claim. Explicit Worker Outcome
cells establish workbook completion; portal adjudication text does not. The
outcomes, counters and cancelled job status commit together. Late worker writes
cannot change a finalized cancellation. Recovery/storage failures leave delivery
unfinished and the watchdog retries; it also revisits historical cancelled jobs
whose published count is below their submitted count.

Deploy the API, watchdog and rebuilt Fargate worker image together. The watchdog
needs output-bucket `s3:ListBucket` and input/output `s3:GetObject` permissions,
included in `sst.config.ts`. No new schema or
migration is required beyond the existing result-ledger migration 0008. The
rollout assumes there are no running jobs using the old publisher. Historical
unpublished outcomes are not generally backfilled by polling; stopped jobs use
the stop-confirmed reconciliation described above.

SST also subscribes a Lambda to `ECS Task State Change` / `STOPPED` events on the
default EventBridge bus, filtered to this stage's cluster and worker task family
(including older revisions). It identifies the job from the worker's `JOB_ID`
override, falling back to ECS `startedBy`, and ignores mismatched task ARNs and
deleted jobs. Event environment overrides are never logged.

Website jobs use the existing runtime reconciler. AR Claim Status jobs reuse
the cancellation recovery and immutable publication transaction: cancelled jobs
keep `CANCELLED`; unfinished claims after a crash/OOM receive `TASK_FAILED`;
deadline stops use `DEADLINE_EXCEEDED`; a clean exit with missing results retains
`OUTPUT_MISSING`. Completed claim payloads and cursor sequences do not change.
An already terminal, fully published worker result is left unchanged.
Otherwise status is derived from committed outcomes and worker exit information:
all-success with a clean exit is completed, some success is partial success,
and no success is failed. Cancellation always remains cancelled.

The existing minute watchdog now checks known task ARNs for STOPPED before
applying the stall/deadline policies, and revisits terminal AR Claim Status jobs
with unfinished delivery. This retries failures or missed events without waiting
20 minutes or for AR's execution deadline. Running-job stall and deadline policies
are unchanged. EventBridge/Lambda retries and repeated watchdog checks are safe;
the transaction rechecks job ownership, task ARN and cancellation state.

Deploy `sst.config.ts`, the event handler and backend changes together. SST
creates the rule, Lambda invocation permission and runtime role permissions.
The existing worker-push/build/SST dev deployment commands remain sufficient.
No additional route, table or migration is introduced.
