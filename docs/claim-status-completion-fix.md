# Premature success publication from partial workbooks

## Confirmed incident

The running Optum job in the 12 November 2026 screenshots is
`9190fdba-22d6-4ca3-a202-b952ca40cdd1`, created at 12:57:59 IST with 359
submitted claims. This is a different job from the earlier OTP failure.

Read-only comparison confirmed:

- The worker's counter was 20, then 22, while the publication table already
  contained 359 `SUCCESS` entries.
- **358 frozen publications themselves contained `Bot Status: Not processed`.**
  They were published when only one worker row had finished.
- A later worker snapshot contained 22 finished rows and 337 `Not processed`
  rows. All 359 rows had a populated canonical final-status cell because the
  writer uses dash placeholders for missing fields.
- Running the corrected normalizer offline on that same saved snapshot
  produced 22 finalized outcomes and 337 incomplete rows. Its processing
  breakdown was 0 success, 3 no-match and 19 failed. Finalized/processed is
  not a count of successful claims or paid adjudications.
- The new read-only SQL guard matched the 358 explicitly unfinished frozen
  successes on the live table. No records were changed by this investigation.

The AR screenshot's `Running` state was consistent with an active worker.
Its `359 processed` and `200 Success` values came from premature service
publications, not from 359 completed portal lookups. AR was polling and
applying the data it received.

## Cause

Optum intentionally writes every submitted claim into its partial workbook.
Unfinished claims are represented by:

```text
Bot Status = Not processed
Bot Message = Not processed.
Claim Status / Final Status / amounts = -
```

The generic service parser previously used:

```ts
if (raw || note || row["Claim Status - Final Status"] || row["Claim Status"] || row.BotClaimStatus) {
  return { status: "SUCCESS", reason: "" };
}
```

`Not processed` matched none of its error/no-match expressions and then passed
that nonempty-value check. Every placeholder became a success. The durable
publication ledger correctly froze what it was given, but that made those
incorrect payloads persist on later polls even as the worker progressed.

The ordering/cursor fix and five-field projection did not establish this
missing completion check. Earlier tests omitted pending rows or used blank
statuses. They did not exercise Optum's actual populated-placeholder writer.
That gap made the earlier assurance about complete portal coverage too broad.

## Change

`claim-completion.ts` centralizes completion classification for all 15 Claim
Status portal normalizers:

- Inspect native worker-owned status columns; do not infer completion from
  source `Status`, canonical fields or arbitrary populated notes.
- Preserve the presence of blank status columns, so a blank native field
  cannot fall back to a source/adjudication status.
- `Not processed`, `Not started`, `Not checked`, active worker states and
  unknown statuses remain incomplete. Known final worker outcomes determine
  success, no-match, failure or action-required.
- Preserve native adjudication encodings: Blue Shield `Paid`/`Denied`/`Claim
  pending`, Waystar paid/denial, and Optum in-process claims with a returned
  claim number represent completed lookups. Medpoint/Regal's output-only
  final-status rows require evidence of an actual result. Waystar's NA row
  needs its explicit missing-EOB note to be a no-match.
- A grouped claim with an unfinished detail stays incomplete even when
  another detail has already failed. Completed different references can
  still publish out of order.
- Dash placeholders map to null canonical values. This does not turn a null
  payment into zero, and it does not discard a numeric/string zero.

New publications are independently checked against their worker details.
The result store also checks for frozen successes with explicit unfinished
native markers across the ledger and validates the payloads on the requested
page. Contradictory successes return **HTTP 503 with a correction-required
message**, rather than deliver more false successes or advertise a completed
progress count. The guard does not inspect a possibly stale current snapshot
to decide that a valid frozen publication became invalid.

No entries are deleted, rewritten or re-sequenced. No cursor is reset. No
worker ordering is imposed. Old sparse payloads without detail rows cannot
be retrospectively proven correct by this guard and are not silently enriched.

## Files/functions

- `backend/src/aws/service/claim-completion.ts`: shared classification and
  native status-column selection.
- `generic-claim-status-results.ts`: preserve empty headers, classify through
  the shared policy, wait for unfinished details before finalizing groups.
- `availity-results.ts`, `iehp-results.ts`: use the shared completion policy;
  preserve explicit unsupported-payer and error categories.
- `result-publication.ts`: `validateClaimPublication`, used before new rows
  are recorded and when existing rows are delivered.
- `result-publication-store.ts`: read-only frozen-placeholder detection under
  the existing job lock; stop before committing/delivering contradictory rows.
- `result-publication-test-helpers.ts`: exercise the guard in the repository fake.
- `backend/src/workflows/claim-status/output-columns.ts`: null dash/unfinished
  placeholders in the canonical projection.
- `backend/src/scrapers/optum-pro/claim-status.ts`: export the existing pure
  placeholder/writer functions for regression tests; no browser logic changed.
- `claim-completion.test.ts`: actual Optum writer and all-portal regression cases.

## Existing affected execution

The running worker can continue saving real outcomes. Neither stopping nor
rerunning portal automation is required to diagnose or recover these data.
Deployment alone does **not** repair this execution: it has already exhausted
all 359 publication positions with incorrectly finalized payloads, and AR
deliberately ignores duplicate finalized deliveries.

Proposed recovery, as a separately approved operation:

1. Pause AR polling for this affected execution while preserving its saved
   cursor/rows and the original service ledger for audit. Do not stop the
   worker merely because its progress display is wrong.
2. Let the worker finish, or select a precisely identified latest snapshot
   if an interim correction is explicitly needed. Save the artifact identity
   and normalize it using the corrected parser with the original submitted
   reference list.
3. Produce a dry-run correction manifest keyed by job ID and `client_row_ref`,
   showing original finalized state, corrected processing outcome and the five
   canonical fields/detail rows. Never mark unfinished rows as successful.
4. Reconcile AR using a dedicated audited correction operation that can update
   already-finalized erroneous rows, with expected old revisions and an
   idempotent correction ID. A cursor replay alone is insufficient.
5. Reconcile the AR execution counters/status with actual corrected outcomes.
   Preserve original cursor history. Historical service corrections need an
   explicit versioned correction/export or reviewed maintenance procedure;
   do not delete ledger rows or pretend rewriting frozen payloads preserves
   their original idempotency contract.

No such live correction, AR modification, cancellation, restart or deployment
was performed in this change. See `claim-status-result-fields.md` for the
general audited recovery requirements.

## Verification and deployment

Regression coverage includes an actual native Optum workbook with 359 rows:
zero finished rows, 17 scattered finished rows, replay, and delayed completion
of an earlier row. Only finalized references advance the publication cursor.
All 15 portal normalizers are tested with populated placeholders, misleading
input/canonical fields, unknown states and legitimate final outcomes. Tests
also cover grouped unfinished/failed details, already frozen false successes,
native adjudication pending states and terminal output-missing failures.

Validation: **214 tests passed across 16 selected files**, including 23 new
completion regression cases. ESLint and whitespace checks passed. Full
TypeScript checking still reports the same 17 pre-existing errors outside
the changed completion/publication files. The corrected parser was also run
read-only against the incident's saved snapshot, and the SQL guard was
validated with a read-only aggregate query on the existing ledger.

Deploy the **Lambda/API** to activate completion detection and ledger guards.
Existing workers' saved workbooks are readable by the corrected parser.
Rebuilding the Fargate image also carries the shared dash-to-null workbook
formatting change to new tasks; no browser automation change is required for
the central completion fix. No frontend change or database migration is needed.
Coordinate deployment with the affected-execution recovery because the guard
intentionally returns 503 for that corrupt historical ledger until it is
handled through a reviewed correction workflow.
