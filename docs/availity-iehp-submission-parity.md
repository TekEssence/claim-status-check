# Availity and IEHP submission parity

This is the historical first-iteration report. The remaining portals have since
been audited and updated; see [the complete Claim Status report](claim-status-submission-parity.md).

Scope: Claim Status for Availity (Minimax, Medrevenu, Charm) and IEHP. This is the first portal iteration requested by the user; other portals and other workflows are deferred. Changes are local and have not been deployed.

## Paths before the change

### Manual upload

Availity:

1. `frontend/src/workflows/claim-status/portals/availity/useAvailityController.ts`, `submit`: require claim/login files, attach project and optional Charm selection-rule file.
2. `frontend/src/api/scrape-jobs-api.ts`, `startAwsScrapeJob`: send file descriptors and form fields to `POST /jobs`.
3. `backend/src/aws/http/jobs.ts`, `createJob`: authenticate the user, create job metadata and signed S3 upload URLs. No portal claim validation occurs here.
4. Frontend uploads the files and calls `/jobs/:jobId/confirm`; `confirmJob` calls `launchQueuedWorkflowJob` to launch the ECS worker.
5. `backend/src/aws/worker/claim-status-worker.ts`, `buildFormData`/`main`: download inputs, select the registered scraper, pass the reconstructed form to its runner.
6. `parseAvailityInput`: normalize project, read optional rules and first-sheet claim/login workbooks, normalize headers and text/date cells, ignore empty spreadsheet rows, select project credentials, map field aliases/defaults and preprocess the batch. Produces existing `AvailityInputRow` records.
7. `runAvailityClaimStatusJob`: load payer/provider mappings and initialize login/MFA; skip unsupported payers; resolve row selections; call `services/row-validator.js`, `validateRow`, using project requirements; mark invalid rows skipped and continue. Provider-selection exceptions are handled in the row execution path.
8. Existing portal workflows run, then `createAvailityOutputWorkbookBuffer` writes output, validation audit and error sheets; worker persists artifacts/events.

IEHP:

1. `ClaimStatusPage.tsx` loads the workbook through `shared/workbook-files.ts`, `loadIehpWorkbookBundle`: first sheet, native cell types, nonempty rows and original indexes. It sends both the workbook and a JSON sidecar, login file, filenames and start index.
2. The same `startAwsScrapeJob` -> `createJob` -> S3 upload -> confirm -> ECS worker path runs.
3. `parseIehpClaimStatusInput`: read login workbook, trim credentials, normalize login URL, apply claim-status URL fallback; prefer the actual claim workbook over the JSON sidecar, parse with `cellDates: false`, assign original indexes, reject an empty job. The JSON-only fallback remains supported.
4. `runIehpClaimStatusJob`: use the existing browser chunks/login/OTP flow. For each row, `getIehpClaimSearchFields` resolves member/DOS aliases. Missing/NaN identifiers or DOS, and dates rejected by `parseDateInput`, emit a skipped row update and progress, then continue.
5. Existing claim/CPT/modifier/RA processing runs. Worker applies row events to the workbook, saves snapshots and the final artifact/bundle.

Both workers can fail at job level on unusable workbooks, invalid credentials/configuration, login/browser failures, infrastructure errors or missing required output. Row handling does not guarantee execution if login fails first.

### Service / AR

Common entry path:

`POST /service/jobs` -> `submitServiceJob` -> bearer authentication/client-system matching -> execution/idempotency IDs -> `reserveServiceSubmission` (reuse/conflict detection) -> workflow/portal dispatch and deadline checks -> portal adapter `prepare` -> job reservation in preparing state -> S3 input writes -> ready state -> `launchQueuedWorkflowJob` -> the same worker/scraper/parser/row execution described above.

Before reservation, Availity preparation previously ran:

`validateAvailityServiceInput` -> scalar/envelope/credential checks -> **a second project-column mapping plus required-field, date, Charm provider-identifier and Medrevenu Group checks** -> `generateAvailityServiceInput` -> claim/login/rule workbooks -> **selection-rule parsing inside the HTTP preparation step**.

IEHP previously ran:

`validateIehpServiceInput` -> `validateIehpClaims` -> scalar/envelope/credential checks plus **member ID and nonempty DOS checks** -> `generateIehpServiceInput` -> claim/login workbooks and correlation JSON.

The HTTP handler returned 422 for preparation errors before reserving a job. Thus one invalid claim could prevent every other claim reaching the shared worker.

## Differences found and fixes

| Portal | Difference | Classification and resolution |
| --- | --- | --- |
| Availity, all projects | Service duplicated field mapping and batch-rejected missing required fields or invalid service dates; manual processing preserved these as row failures. | Bug. Remove the service business-validation loop. Existing worker mapping and row validation remain authoritative. |
| Availity Charm | Service always required row NPI or Tax ID. Worker can use configured selection rules to determine provider mode/order without them. | Bug. Defer provider decisions to the existing selection pipeline. With no applicable alternative rule, the existing provider error still occurs per row. |
| Availity Medrevenu | Service rejected a missing Group before job creation. | Bug in rejection severity/timing. Current project configuration still requires Group in worker provider selection; it is now evaluated there for either transport. No NPI fallback was added. |
| Availity selection configuration | Service checked project eligibility and parsed selection-rule business values during input generation; manual parsing did this in the worker. | Divergent validation placement. Encode rules only; `readOptionalSelectionRules` remains the single shared rule parser. Unsupported project/rule values remain job-fatal with the same messages, before portal login. |
| IEHP | Service batch-rejected a missing member ID or DOS, whereas worker emits skipped row results and continues. | Bug. Remove `validateIehpClaims`; retain service-envelope checks and existing worker row handling. |
| IEHP mixed aliases | Service workbook padded absent fields with empty strings. An empty `Date Of Service` could shadow populated `DOS`, or `Member Policy ID` could shadow `Member ID`, because the native reader uses nullish fallback. Manual blank cells remain absent. | Additional conversion bug. Shared encoder now emits absent cells for null/missing values, retaining explicit strings, numbers, booleans and leading-zero IDs. Independent manual/service fixtures reproduce and cover this case. |

No duplicate filtering was introduced: repeated logical claim data with different row references remains separate rows. Existing project row sorting and original identifiers remain intact. Existing portal date formats, amounts, defaults, payer/provider mappings and automation behavior were retained.

## Shared boundary after the change

The existing worker parsers are reused instead of introducing a second domain model:

```text
Manual claim/login workbook --------------------+
                                               |
Service JSON -> envelope parser                 |
             -> encodeServiceClaimWorkbook -----+
                                               v
                        Same worker workbook parser
                                               v
                      Existing flat, header-keyed claim records
                                               v
                   Same portal mapping/defaults/preprocessing
                                               v
                   Same row validation and portal execution
                                               v
                           Same output workbook
```

`AvailityInputRow.data` and IEHP's `IehpGenericRow` are existing internal row representations. Neither portal parser nor the portal row rules use submission source to select business behavior. The shared encoder preserves supplied columns and cell types and adds correlation fields; it does not map payer/member/provider fields or validate claims. Portal rules run once, inside the worker, following the same sequence as manual uploads.

The convergence remains inside the worker rather than adding a second preparation pass to HTTP ingestion. Service-generated workbooks are an encoding of JSON transport, consumed by the same parser as uploaded workbooks. The tests compare independently generated manual files with service output, not two copies of a service-generated file.

## Files/functions changed

| File | Functions/change |
| --- | --- |
| `backend/src/aws/service/claim-workbook.ts` | New `encodeServiceClaimWorkbook`: common transport encoder, correlation fields, absent-cell preservation. |
| `backend/src/aws/service/availity-input.ts` | `validateAvailityServiceInput`: remove portal row and selection-project checks. `generateAvailityServiceInput`: reuse encoder and remove rule-business parsing. Login/rule workbook schemas remain compatible. |
| `backend/src/aws/service/iehp-input.ts` | Remove `validateIehpClaims`; `validateIehpServiceInput` uses envelope-only `validateServiceClaims`. `generateIehpServiceInput` reuses encoder. Document allowable envelope validation. |
| `backend/src/workflows/claim-status/portals/availity/input.ts` | Document the canonical row/shared preparation boundary in `parseAvailityInput`; runtime unchanged. |
| `backend/src/workflows/claim-status/portals/iehp/input.ts` | Document workbook precedence and shared row semantics in `parseIehpClaimStatusInput`; runtime unchanged. |
| `backend/src/aws/service/availity-iehp-input-parity.test.ts` | 15 new independent transport, mixed-row, alias, provider-rule, authentication and idempotency tests. |
| `backend/src/aws/service/availity-service.test.ts` | Update obsolete batch-rejection expectations; assert invalid selection project is rejected by the shared parser. |
| `docs/availity-iehp-submission-parity.md` | This report. |

`service-jobs.ts`, worker execution, portal selectors and public API fields were not changed.

## Service-only checks and legitimate differences retained

- Authentication, matching client system, execution ID, idempotency key, supported workflow/portal and deadline are service-contract concerns.
- Claim-array size remains 1–10,000; unique nonempty `client_row_ref`, object/scalar cell shape, field-count/name restrictions and protected output/correlation columns remain service-contract checks. These do not assert required portal claim data.
- Service credential objects still require their existing fields and lengths, including Availity TOTP secret. Manual credentials continue to come from their native workbook schemas and project/account selection. Actual URL normalization, credential parsing, authentication and OTP behavior remain in their existing shared runners.
- Selection-rule JSON retains its structural/scalar checks and 1–1,000 row limit. Its project and rule-business validation now occur only in the shared rule parser.
- Service uses generated filenames, start index zero, execution correlation, deadlines and idempotency. Manual keeps uploaded filenames, resume positions and empty-spreadsheet-row filtering. Explicit service claim objects retain references even if all claim data is invalid.
- Existing service result pagination and normalized status aggregation remain intact. A mixed-result service job can be `partial_success`; a manual run can be `completed` after all rows finish while its workbook records skipped/failed claims. Output upload requirements and cancellation reconciliation also remain integration-specific. This pass establishes claim preparation/validation parity, not identical HTTP responses or every job-lifecycle status.

## Other portals / next iterations

The Claim Status registry currently lists 15 portals. Availity and IEHP are covered here. Aerial, All Care, Astrona, Blue Shield, Cigna, Kaiser, Medpoint, My Family, Optum Pro, Physicians, Regal, UHC and Waystar remain for later portal-specific audits. Their existing service and valid-input parity regression tests were run and passed; this does not establish invalid-row/business-rule parity for them.

They currently use `prepareGenericClaimStatusServiceInput` and `claim-status-workbook-validation.ts`; some readers/credential routing are invoked before service job creation. Their exact fatal-versus-row semantics must be audited individually in the next iterations. No Claim Status portal named TMRV was found in the backend/frontend/docs searches or active registry; its identity needs resolving before a TMRV-specific iteration. No unsupported portal was added or renamed.

## Validation results

- New parity suite: **15/15 passed**.
- Expanded local regression run across 19 test files: **175 passed, 3 failed, 178 total**. This includes all new tests, service adapters for the other portals, result correlation/pagination, 10,000-row input/output checks, reservation/retry/token-rotation tests, worker packaging, mocked OTP flows and IEHP date/CPT/RA tests.
- The three failures are in unchanged `availity/project-config.test.ts`: old expected Charm headers omit `Availity Selection`/`Availity Match Details`; old ICM expectation says `Institute on Complementary Medicine` instead of current `Institute of Complementary Medicine`; old Dumont expectation says `Open Mind Health` instead of current `Dumont Florida PLLC`. The test, configuration and configuration implementation all match HEAD and do not depend on the changed input modules. Portal settings were not changed to satisfy these assertions.
- ESLint passed on all seven changed/new TypeScript files. `git diff --check` passed.
- Repository `tsc --noEmit --incremental false` reports errors only in untouched All Care/Astrona/Blue Shield test files, eligibility test files and Ebridge's missing `DownloadDocument` type. No changed file reports a type error.
- No live portal browser sessions, AWS jobs, production calls or deployment were performed. Browser-related regression tests use existing mocks/fixtures.

## Confirmation and limits

For Availity and IEHP, equivalent parsed claims now reach the same portal preparation and validation behavior regardless of manual versus service source. Invalid claim data no longer causes the service adapter to reject an entire batch before the shared worker handles it. Existing fatal configuration/login behavior and required row rules remain enforced.

This confirmation is supported by independent input fixtures and local regressions, not a live portal run. It does not claim the deferred portals are corrected, that all existing repository checks are green, or that manual and service job-status presentation is identical. Rollback consists of reverting the scoped input/test/documentation changes; there is no schema migration or API migration.
