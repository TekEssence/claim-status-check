# Shared Claim Status worker results

All 15 Claim Status portals now use one execution-outcome contract, one Fargate
result producer, one API result reader, and the existing durable cursor ledger.
Portal login/search/extraction and payment-field projection remain adapters.
Eligibility is a separate workflow and retains its existing result contract.

## Authority and data flow

1. Portal workers report execution codes in their native output. The shared
   `worker-outcome.ts` adapter stamps `Worker Outcome` using one closed set:
   `SUCCESS`, `NO_MATCH`, `FAILED`, `ACTION_REQUIRED`, `INCOMPLETE`.
   A declarative column-name map selects the worker's execution field. It never
   falls back to submitted Status fields or another portal's similarly named
   column. Paid, Denied and Pending cannot establish execution success.
2. Blue Shield and Waystar now record an explicit outcome at their lookup
   decision, independently of the adjudication value in their existing output
   columns. Medpoint and Regal now explicitly report lookup execution status.
   Optum explicitly marks the branch where a payer's In Progress claim was
   successfully found; unattempted placeholders remain incomplete.
3. `claim-result-publisher.ts` reads every portal workbook using the same code
   in Fargate. It groups detail rows by stable submitted reference (or a
   worker-provided original input index where the workbook omits the UUID).
   Waystar continuation rows and its one-based input indexes are handled by
   workbook schema, including error-only snapshots. UHC no longer copies Bot
   fields between different claims sharing member and DOS.
4. Fargate publishes `${outputPrefix}/worker-results.v1.json` in the existing
   private output bucket. The manifest identifies its job and producer, and
   each result carries an explicit version and outcome. It includes all five
   canonical fields and all detail rows, including single-row results. Zero
   payments survive. Conflicting detail amounts are retained in details rather
   than guessed into an aggregate amount.
5. Manifest writes are serialized. Previously finalized references and payloads
   are immutable, survive stale snapshots, and are restored on worker restart.
   Progress advances only after a manifest save succeeds. A failed save can be
   retried without losing the worker's collected outcomes.
6. Every Claim Status entry in `servicePortals` points to
   `loadWorkerResultSnapshot`. The former portal snapshot loaders delegate to
   it too. Lambda reads the worker JSON and validates the contract; it never
   parses a workbook to decide that a new Claim Status result succeeded.
   Historical workbook normalizers remain available for inspection/tests and
   are not service result publishers.
7. The API appends unseen finalized references to `workflow_service_results`
   under the existing per-job lock. The public cursor is the durable sequence
   count. A/C/D can be delivered while B is pending; B appends when it completes.
   Repeating a cursor returns the same frozen page. Advancing the cursor never
   returns the same reference twice. Unique database constraints remain in use.

## Progress and stopping

`total` is the number of submitted client references. `processed` is the number
of finalized outcomes recorded in the public ledger. `pending = total - processed`.
Worker progress for service jobs uses finalized manifest outcomes and the same
submitted total. There is no supported-worker denominator mixed into that total.
An unsupported payer is an explicit finalized FAILED outcome with
`UNSUPPORTED_PAYER`; it is included in total and processed, not silently dropped.

When the worker stops normally, fails, or handles cancellation, the common
Fargate finalizer explicitly records remaining references as FAILED with
`OUTPUT_MISSING` or `CANCELLED`. Lambda no longer creates those claim outcomes
from the job's terminal status. A forcibly killed worker may be unable to write
them: the job can be failed while the missing claims remain pending. That is an
execution/recovery condition, never evidence of successful claims.

New IEHP/UHC service executions clear inherited worker fields from input
workbooks. Manual resumptions with an explicit start index retain their prior
output. Neither adjudication cells nor an old input marker can finalize a new
service claim.

## Deployment and recovery

No deployment or live data repair was performed. This change needs the Fargate
worker image and Lambda/API deployment together. Rebuild the Claim Status
frontend too: UHC frontend workbook processing imports the shared module whose
cross-claim copying was removed. No AR matching changes or additional database
migration are needed; migration 0008 is still required and was applied earlier.

An already running old worker cannot produce the new manifest by deploying a
new image. Coordinate the rollout and review such jobs separately. There is no
fallback that treats an old workbook's populated fields as new success proof.
Historical fully recorded result pages retain their existing cursor/payloads;
legacy completed jobs with unpublished references return a recovery error.
The existing protection against already-frozen unfinished successes remains.

The corrupted Optum job and AR claims already finalized from it will not repair
themselves. Preserve the original ledger and cursor evidence. Use the final
worker workbook and original submitted references to prepare a reviewed
correction set. Confirm each corrected outcome from actual worker evidence.
Apply an explicitly authorized correction/reconciliation in Claim Status and
AR; AR intentionally ignores duplicate finalized deliveries, so replay alone
cannot repair it. Do not reset cursors, delete the ledger, rerun automation, or
overwrite finalized AR rows automatically.

## Regression coverage

`claim-result-publisher.test.ts` checks shared dispatch and JSON-only API reads
for all 15 portals, A/C/D before B, repeated cursors, late B, immutable payloads,
stale snapshots, multiple detail rows, canonical zero payments, unknown/native
adjudication states, inherited status markers, unsupported payers, cancellation,
storage failures and restored worker state. It also exercises the real Optum
359-row workbook, native IEHP RA output, UHC row updates, and Waystar continuation
and error-only workbooks. Existing ledger/concurrency, five-column, portal writer,
and IEHP/UHC frontend workbook regression suites remain in use.

Validation completed: 248 regression tests across 18 files passed, followed by
the worker startup/dependency check. The API bundle, focused ESLint checks, and
`git diff --check` passed. Full TypeScript checking still reports the same 17
pre-existing repository errors; this change introduces no new type errors.
