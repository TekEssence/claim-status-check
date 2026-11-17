# Claim Status payment and adjudication delivery

## Cause and implementation

IEHP's `groupClaimRows()` returned `rows[0].normalized` for single-row claims.
That intermediate object contained only `claim_status` and `claim_details`.
It never attached the structured RA/workbook fields. The multi-row path did
attach details, but its allowlist also excluded the five canonical workbook
columns. This was a service serialization problem, independent of AR polling.

`iehp-results.ts` now groups single and multiple rows through the same path,
retains `BotClaimDetails`, RA fields and canonical workbook fields, and always
attaches `detail_rows`. Existing outcome classification is unchanged: a
successfully checked denied claim has processing `status: SUCCESS`, while
adjudication is available separately in the canonical final status/RA status.

`claim-status-result-fields.ts` is shared by the IEHP, Availity and generic
Claim Status normalizers. All 15 Claim Status portal IDs and their projects
now expose these exact keys both in `result` and in each `detail_rows` entry:

- `Claim Status - Denial Code`
- `Claim Status - Remark Code`
- `Claim Status - Paid Amount`
- `Claim Status - Copay/Coins/Ded`
- `Claim Status - Final Status`

Keys are mandatory; values are nullable. Missing workbook data is `null`, not
an invented code, payment or adjudication. Existing numeric/string zero is
preserved, including cached formula zero. Native workbook detail columns are
retained. Eligibility/EOB contracts are not changed by these projections.
Terminal Claim Status rows with no worker output have the same five nullable
keys and an empty `detail_rows` array.

At the claim level, a canonical value is copied only when every detail agrees
and provides a value. Different or partially missing values produce `null` at
the claim level; their actual values remain in the individual detail rows.
The service does not sum ambiguous detail/check/service-line amounts or
concatenate conflicting money values. Consumers needing a claim-level total
for conflicting details must define aggregation using the detail semantics.

`output-columns.ts` supplies the shared native-to-canonical projection:

- Existing explicit canonical workbook cells are preserved when reading results.
- IEHP `RA Net Paid` takes precedence over canonical/other amount aliases;
  `RA Check Amount` and `Billed Amount` are never claim-payment fallbacks.
- IEHP adjustment codes are taken only from identifiable numeric or
  CO/PR/OA/PI/CR code tokens in `RA Reason`; M/MA/N numeric tokens are remarks.
  Descriptive denial prose stays in its original field.
- Availity's untyped narrative "denial reason" is no longer relabeled as a
  remark code. Explicit canonical or typed remark fields remain available.
- Processing words such as `SUCCESS` are not canonical adjudication values.
- Workbook writers refresh derived canonical cells from native source cells
  on each snapshot, rather than retaining a previous projection.

## Publication and compatibility

Grouping remains one result per submitted `client_row_ref`, regardless of how
many workbook details share that reference. Different submitted references
are not deduplicated by member, claim number or lookup data. No AR matching
logic or cursor allocation/order was changed. An incomplete detail group stays
unpublished while other completed references can publish. Ledger payloads
are still frozen at first publication, protected by the per-job lock and
unique job/reference and job/sequence constraints.

Changed functions/files:

- `iehp-results.ts`: `groupClaimRows`, `normalizeIehpServiceWorkbook`, field allowlist.
- `availity-results.ts`: `normalizeAvailityServiceWorkbook`.
- `generic-claim-status-results.ts`: `normalizeGenericClaimStatusWorkbook`.
- `claim-status-result-fields.ts`: shared `claimStatusResultFields` projection.
- `output-columns.ts`: `iehpCodes`, `claimStatusOutputValues`, `appendClaimStatusOutputColumns`.
- `service-contract.ts`: detail values permit strings, numbers and nulls.
- `result-publication.ts`: optional Claim Status portal for terminal placeholders.
- `service-jobs.ts`: passes that context for Claim Status jobs only.
- `claim-status-result-fields.test.ts`, `iehp-service.test.ts`, `output-columns.test.ts`.

## Recovery for existing jobs

This change intentionally does not mutate stored publications, reset cursors,
reopen finalized AR claims or rerun portal automation. Replaying an old cursor
returns its frozen original payload, and AR's finalized-result deduplication
would ignore it anyway. Deleting ledger entries or resetting AR's cursor
cannot safely serve as a repair.

Proposed procedure, requiring a separately reviewed and explicitly authorized
correction operation:

1. Identify affected job IDs and `client_row_ref` values in the correct client,
   execution and project scope. Preserve the saved authoritative workbook,
   artifact version/ETag, ledger entries and AR rows before any change.
2. Run the corrected normalizer offline against the saved workbook and the
   original submitted reference list. Do not rerun the portal. Validate ref
   membership, one grouped result per ref and complete worker outcomes. Leave
   genuinely incomplete/missing data for manual review.
3. Prepare a restricted correction manifest keyed by job/client execution and
   `client_row_ref`, containing the five corrected values, complete detail rows,
   old values/revisions, artifact identity, parser version and a deterministic
   correction ID. Produce a dry-run diff; explicitly review zero vs missing,
   multi-detail conflicts and any existing user edits. Do not print patient
   data or credentials to logs.
4. After approval, use a dedicated AR reconciliation/import operation that
   explicitly permits corrections to already finalized rows. Match the UUID,
   verify scope, compare the expected previous row revision/values, and update
   only approved adjudication/payment columns and stored detail payload. Keep
   processing outcome, job association, finalization and polling cursor intact.
   In one transaction, record the correction ID and before/after audit data.
   Repeating the same correction ID must be a no-op; concurrent edits must
   cause a conflict for review rather than an overwrite.
5. Reconcile the correction count/reference set and zero/money values against
   the manifest, then retain an audited rollback using the captured old values.
   If service-side access to corrected historical payloads is also needed,
   use a separately designed versioned correction channel/export; preserve the
   immutable original cursor ledger. No such write endpoint or AR correction
   tool is implemented by this patch.

Claims with no ledger entry yet will use the corrected parser after the API
deployment, even when their workbook was generated by an older worker. Claims
already recorded in the ledger need the explicit procedure above whether or
not their original API response was successfully consumed by AR.

## Deployment and verification

Deploy **Lambda/API** for service serialization and **Fargate worker image**
for the shared workbook projection changes on new tasks. The API can read
existing saved workbooks; a worker rerun is not needed to recover their data.
No new database migration or frontend/AR matching change is required for this
patch. The existing publication-ledger migration remains a prerequisite.

Focused regression coverage includes single details, multiple details,
zero/denied payments, explicit canonical cells, raw RA Net Paid precedence,
missing codes, incomplete details, late completion, repeated pages, immutable
legacy payloads, terminal placeholders, cached formula zero, all 15 portal
normalizers and workbook snapshot refresh.

Validation for this patch: 191 tests passed across 15 selected files, including
25 new focused cases in `claim-status-result-fields.test.ts`. ESLint passed
for the changed TypeScript files, and `git diff --check` passed. Full
`tsc --noEmit --incremental false` still reports the 17 previously known
errors in unrelated All Care/Astrona/Blue Shield tests, eligibility buffer
types and the Ebridge scraper; no error points to this patch's changed files.
