# Stable result publication across Claim Status portals

## 1. Old cursor logic and confirmed cause

Availity, IEHP, the generic Claim Status normalizer and eligibility each reconstructed `row_results` in `expectedRefs` submission order. They computed `finalized_count` as the index of the first `INCOMPLETE` row. `pageServiceResults` then sliced only that consecutive prefix while a job was active. The HTTP handler exposed that prefix length as `processed`.

Charm legitimately sorts work by state/practice/payer. For the reported job, its first worker lookups were submitted rows 1, 22, 28, 33, 50, etc. Submitted row 2 was supported lookup 805. Thus the original API could report processed 1 while many other claims had complete results. The separate total discrepancy was 1,279 submitted claims versus 1,218 supported-payer lookups, excluding 61 unsupported rows from worker progress. Neither discrepancy came from AR polling or deduplication.

## 2. New publication logic

All service publishers now use one durable, append-only publication model:

1. Native portal normalizers continue correlating/aggregating rows by submitted `client_row_ref`. Their common `summarizeServiceResults` counts every finalized claim anywhere in a snapshot; it does not compute a prefix.
2. The HTTP handler loads the snapshot and expected references, then calls `publishServiceResultPage`.
3. In one database transaction, `recordServiceResultPage` locks the owning job row with `SELECT ... FOR UPDATE` and reads its publication ledger.
4. `planServiceResultPublications` selects every finalized reference not already recorded. A batch is assigned in submitted-reference order for deterministic initial assignment, but it never waits for missing earlier references.
5. Each selected claim receives the next per-job sequence number and a frozen normalized payload in `workflow_service_results`.
6. The page reads ledger sequences strictly greater than `cursor`, up to `limit`. `next_cursor` is the last sequence consumed by that page (equivalently its zero-based offset for the next request).

Example:

```text
Submitted:              A B C D
First complete set:     A   C D
Persisted publications: 1:A  2:C  3:D
cursor=0, limit=100:     A,C,D     next_cursor="3"

B finishes later:
Persisted publications: 1:A  2:C  3:D  4:B
cursor=3, limit=100:     B         next_cursor="4"
```

Filtering a live submitted-order array and slicing it was deliberately avoided: B's later completion could otherwise insert ahead of C/D and cause duplicate or skipped delivery. Neither worker execution nor AR's reference matching is forced into submission order.

## 3. Pagination, retries and concurrency

- Primary key `(job_id, client_row_ref)` permits only one publication per submitted reference. Unique `(job_id, sequence)` and positive-sequence constraints protect cursor allocation.
- The job-row lock serializes concurrent publishers. Sequence assignment, inserts and page reading commit atomically. A failed transaction rolls back; a lost response after commit can be retried without inserting duplicates.
- Already recorded payloads/sequences are immutable. A later or temporarily older snapshot cannot remove a publication, regress recorded progress or change a replayed entry.
- Every consumer retains its own numeric cursor. Advancing using `next_cursor` returns only entries after the consumed sequence. Reusing an earlier cursor intentionally replays entries, allowing recovery from a lost response; it is not a second ledger publication. AR continues upserting by `client_row_ref`.
- A response may include newly appended entries within the requested limit when an old cursor is retried. Existing sequence positions and payloads remain identical. An empty page never reserves/fixes that cursor; new completions can appear there later.
- Initial assignment follows the same order as any already-completed legacy submitted prefix, allowing continuation of a legacy prefix cursor when the ledger is initialized. During rollout, avoid mixing old-prefix API responses and new-publication API responses in a single in-flight consumer session. Pause/drain old polls when switching versions; if mixed-version responses have already occurred, restart that polling session at cursor zero and rely on reference upserts. There is no cursor migration that can infer unrecorded acknowledgements from old clients.

This provides unique publications and safe cursor-based replay, not an impossible guarantee that HTTP responses cannot be retransmitted after a network failure.

## 4. Progress contract

| Field | Meaning |
| --- | --- |
| `total` | Number of submitted unique `client_row_ref` values. Includes unsupported rows. |
| `processed` | Number of finalized per-reference outcomes recorded in the publication ledger, whether or not the current page has delivered all of them. Includes successes, no matches, failures and explicit unsupported/cancelled outcomes. Never a consecutive-prefix length or number of detail rows. |
| `pending` | `total - processed`. Claims without a recorded final outcome. |
| `unsupported` | Number of recorded results whose `error_category` is `UNSUPPORTED_PAYER`. This is a subset of `processed`, not an additional denominator. |
| `next_cursor` | Decimal offset after the page's consumed ledger entries. It can be less than `processed` while pages remain to be drained. |
| `final` | Job is terminal, pending is zero, and this page reaches the ledger's end. A terminal job with remaining pages still returns false. |

At terminal failure/cancellation, missing or unfinished per-reference output becomes an explicit `FAILED` result with `OUTPUT_MISSING` or `CANCELLED`; it is not represented as successful automation or silently discarded. Already recorded outcomes remain intact. Therefore processed means recorded final outcomes, not necessarily claims visited by a browser. Missing required final artifacts still cause a retryable 503 rather than speculative success.

New submissions retain fallback `serviceClaimRefs` job metadata so an input-upload failure can still be correlated when `claimRows.json` was never saved. Old failed jobs without either saved references or fallback metadata return 503 instead of fabricated identities.

## 5. Unsupported rows and worker progress

Availity now separates supported and unsupported rows after its existing shared input preparation. Unsupported rows immediately get skipped workbook results before browser login. They normalize to `FAILED / UNSUPPORTED_PAYER` and remain individually correlated. A job containing only unsupported rows produces explicit outcomes without launching a browser.

Worker progress now uses all submitted/prepared rows as its denominator and includes finalized unsupported rows in completed progress. Supported claims retain their existing project sorting and automation order. Snapshots and output retain all references. For 1,279 claims with 61 unsupported payers, total is 1,279; the 61 explicit failures contribute to processed, and the remaining 1,218 claims proceed normally. No worker selectors or portal business requirements were changed.

Other portals' native per-row/fatal behavior and grouping remain intact; their service counts are computed per submitted reference by the same publication ledger, irrespective of native lookup/group counts. No AR Workflow or frontend matching code was changed.

## 6. Portals and publishers affected

All 15 registered Claim Status portals are covered: Aerial (PMG/Citrus Valley), All Care, Astrona, Availity (Minimax/Medrevenu/Charm), Blue Shield, Cigna, IEHP, Kaiser, Medpoint, My Family, Optum Pro, Physicians, Regal, UHC and Waystar.

The eligibility publisher used the same prefix/cursor helper and is also moved to the common model. EOB service submission has no active result publisher in this registry. IEHP and eligibility can now normalize partial snapshots with absent expected rows as pending when `requireStatusColumns: false`; strict final-workbook validation is retained for callers requesting it.

Different client references sharing member/claim/lookup identifiers remain separate publications. Multiple detail rows belonging to one reference are aggregated by the existing normalizers into one normalized result. An incomplete detail group waits for completion without blocking unrelated references.

## 7. Files and functions changed

| File | Functions/change |
| --- | --- |
| `backend/src/aws/service/result-summary.ts` | New `summarizeServiceResults` and pending-row helper. Central finalized counts. |
| `backend/src/aws/service/result-publication.ts` | New `planServiceResultPublications`, cursor validation and shared durable-sequence paging utility. |
| `backend/src/aws/service/result-publication-store.ts` | New `recordServiceResultPage` transaction and `publishServiceResultPage` retry wrapper. No portal-specific branches. |
| `backend/src/aws/service/availity-results.ts` | Shared count semantics; explicit unsupported-payer classification, including legacy worker skip messages. |
| `backend/src/aws/service/iehp-results.ts` | Shared counts and partial missing-row support; remove prefix pager implementation and re-export only the shared utility. |
| `backend/src/aws/service/generic-claim-status-results.ts` | Shared counts for all 13 generic Claim Status adapters. |
| `backend/src/aws/service/eligibility-results.ts` | Shared counts and partial missing-row support. |
| `backend/src/aws/service/eligibility-snapshot.ts` | Pass partial/final parsing options through. |
| `backend/src/aws/service/service-contract.ts` | Document finalized-count meaning. |
| `backend/src/aws/http/service-jobs.ts` | `getServiceJobResult` publishes/pages durable results, exposes processed/pending/unsupported, and drains terminal outcomes. `submitServiceJob` retains fallback references. Migration errors return a clear 503. |
| `backend/src/workflows/claim-status/portals/availity/claim-status-job.ts` | Explicit unsupported outcomes before login; submitted-row progress and snapshots. |
| `db/schema/workflow-runtime.ts` | Add `workflowServiceResults` schema and constraints. |
| `drizzle/0008_service_result_publication.sql`, `drizzle/meta/_journal.json` | Add/register the forward migration. |
| `backend/src/aws/service/result-publication.test.ts`, `result-publication-test-helpers.ts` | Cross-portal publication and SQL-repository transaction/lock fixture tests. |
| `backend/src/workflows/claim-status/portals/availity/progress.test.ts` | Worker test proving all-unsupported batches finalize progress/output without browser access. |
| `backend/src/aws/service/availity-service.test.ts`, `iehp-service.test.ts`, `multi-workflow-service.test.ts` | Replace obsolete prefix expectations and use the shared publication helpers. |
| `docs/service-claim-status-phase1.md`, `docs/claim-status-submission-parity.md`, this report | Update/link the current contract and rollout requirements. |

Earlier submission-parity work in the working tree is retained. This iteration does not deploy or commit those changes.

## 8. Verification

**257/257 regression tests passed** across 17 service, worker, portal-output and frontend-workbook test files. New cases include:

- A/C/D publishing while B is absent, then B arriving later, for every Claim Status portal and eligibility.
- Repeated/empty polls, multi-page draining, stable replay and unchanged client references.
- Multiple detail rows for one claim and different claims with identical member identifiers.
- Incomplete detail groups that do not block unrelated complete references.
- Concurrent pollers, lost commit responses, transaction rollback and rejection of duplicate/unexpected references.
- Stale/absent snapshots preserving recorded results and nondecreasing processed counts.
- Terminal failure/cancellation accounting, legacy first-initialization cursor continuation and missing-migration 503 behavior.
- The reported 1,279-row shape with scattered original positions: all 12 fixture completions publish instead of only the first one.
- Explicit unsupported classification and an actual local Availity runner invocation with an all-unsupported batch, without browser launch.

A separate read-only offline check loaded the reported job's latest saved workbook into the new pure planner. It found 126 known finalized references versus the old prefix count of 1; its first page contained 100 results with next cursor 100. The job was already recorded as cancelled at that observation. That check deliberately compared snapshot-only publication, without writing a ledger or invoking the updated service API. The actual new terminal API additionally accounts for remaining cancelled references as described above.

ESLint passed on the new/refactored publication modules, API, schema, parser changes and result tests. The repository typecheck still reports the same 17 pre-existing errors in untouched All Care/Astrona/Blue Shield tests, eligibility tests and Ebridge; no changed file reports a type error. The existing large legacy Availity runner has unrelated lint debt and was not rewritten as part of this task. `git diff --check` passed.

Transaction/locking tests use a SQL/transaction fake, not a live PostgreSQL migration. No migration was applied, service API redeployed, production job changed or portal automation launched. No credentials or patient data were printed.

## 9. Deployment and rollback

The complete change requires **database migration + Lambda/API + Fargate worker**:

1. Apply `0008_service_result_publication.sql` using the existing migration process against the intended database. Without it, the new API returns a clear 503; it does not fall back to unsafe prefix pagination.
2. Deploy the worker image and Lambda/API changes through the normal dev/stage rollout. Deploy the backward-compatible worker before the API if also rolling out the earlier credential-scope refactor. Pause/drain old result polling while switching cursor semantics, as described above.
3. The Lambda change alone (after migration) fixes publication for already-running workers and saved snapshots. The Fargate change is needed for the corrected Availity progress denominator and early unsupported outcomes in new tasks. Existing tasks keep their original worker code.
4. No frontend deployment or AR row-matching change is required. Clients continue storing decimal `next_cursor` and applying results by `client_row_ref`.

No deployment or migration has been performed. Preserve the publication table during application rollback so acknowledged sequence history is not lost. Do not switch an advancing consumer back to prefix semantics mid-session; restart/drain its polling session by reference if an API rollback is required.
# Completion validation follow-up

The publication ledger depends on correct worker completion classification.
The 12 November Optum partial-workbook incident and its correction are
documented in [claim-status-completion-fix.md](claim-status-completion-fix.md).
Populated `Not processed` rows must never be treated as finalized successes.

