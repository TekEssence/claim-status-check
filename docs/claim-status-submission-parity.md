# Claim Status manual / AR submission parity

Result publication/progress has subsequently been updated across these same
portals. See [the publication report](claim-status-result-publication.md), including
required database migration 0008 before the updated API is deployed.

The refactor now covers all 15 portals registered by `backend/src/workflows/claim-status/registry.ts`: Aerial (PMG and Citrus Valley), All Care, Astrona, Availity (Minimax, Medrevenu and Charm), Blue Shield, Cigna, IEHP, Kaiser, Medpoint, My Family, Optum Pro, Physicians, Regal, UHC and Waystar.

Changes are local and not deployed. This report covers Claim Status; eligibility and EOB workflows have not been refactored by this task. The [first-iteration report](availity-iehp-submission-parity.md) records the earlier Availity/IEHP work.

## 1. Manual path before the changes

`ClaimStatusPage` / portal form -> attach claim/login files and portal settings -> `scrape-jobs-api.ts`, `startAwsScrapeJob` -> authenticated `POST /jobs` -> `http/jobs.ts`, `createJob` -> job metadata and signed S3 URLs -> frontend uploads -> `/jobs/:jobId/confirm` -> `confirmJob` / `launchQueuedWorkflowJob` -> ECS worker.

`worker/claim-status-worker.ts`, `buildFormData` downloads the files and restores settings. `main` selects the same registered scraper used for AR jobs. Its portal runner calls the native input/credential readers listed below, performs the existing validation, routing, automation and workbook output. The worker persists snapshots, progress, input challenges and artifacts.

IEHP's frontend additionally reads its first sheet to display row counts/indexes and sends a legacy JSON sidecar. UHC's frontend parser is a re-export of the backend workbook parser. Their workers prefer the uploaded workbook over the sidecar. Other portal forms send their workbooks and settings without a separate frontend claim-business pipeline.

## 2. Service path before the changes

`POST /service/jobs` -> `submitServiceJob` -> authenticate service token and client system -> execution/idempotency IDs -> `reserveServiceSubmission` -> workflow/portal dispatch and deadline checks -> portal adapter preparation -> reserve preparing job -> upload generated workbooks and correlation JSON -> mark ready -> `launchQueuedWorkflowJob` -> the same ECS worker and scraper described above.

For the 13 generic adapters, `prepareGenericClaimStatusServiceInput` previously performed the following **before job creation**:

1. Validate JSON/envelope/scalar cells and credential objects.
2. Build the claim workbook, with a separate Aerial alias-to-canonical converter and empty-string padding for absent fields.
3. Call `readServicePortalClaims` from `claim-status-workbook-validation.ts`. This invoked native readers, but additionally rejected any invalid validation status, any Waystar invalid row, an empty parsed set, or a parsed/submitted row-count mismatch.
4. Infer omitted single-account group/payer scopes from those parsed claims.
5. Build the login workbook and call `validateServicePortalCredentials`. This additionally rejected unmatched All Care/Astrona/Blue Shield rows and performed portal parsing/routing inside the HTTP preparation stage.

The HTTP handler returned 422 if any preparation step failed. Consequently, sharing the eventual worker did not provide parity: service-only wrappers could prevent the worker from seeing rows that manual processing would retain as individual failures or intentionally filter.

Availity and IEHP had separate service claim checks. Those were removed in the first iteration, as described in its report.

## 3. Portal comparison and retained severity

All generic service adapters now use `validateServiceClaims` plus `encodeServiceClaimWorkbook`; their business rules live in the native functions below. Paths in this table are relative to `backend/src/workflows/claim-status/portals/`, except Optum Pro.

| Portal | Native shared preparation / validation | Former divergence | Behavior retained in the worker |
| --- | --- | --- | --- |
| Aerial | `aerial/input.ts`: `parseAerialInput`; `aerial/workbook.ts`: `readAerialInputWorkbookFromBuffer`; native subportal credential reader | Separate JSON alias conversion, blanket invalid-row/count rejection, extra credential checks before worker | Invalid subscriber/date rows become row failures. Native empty-row filtering and legacy positional fallback remain. Missing Citrus Valley Group or unmatched grouped credentials remain fatal in native preparation. |
| All Care | `all-care/input.ts`: `parseAllCareInput`, `readAllCareInputRows`, `readAllCareCredentials`, `routeAllCareRows` | Invalid or unmatched row rejected the whole service batch; HTTP-only scope inference | Group/payer/member validation and unmatched credential rows generate individual failures; valid credential batches continue. Malformed login workbooks remain fatal. |
| Astrona | `astrona/input.ts`: corresponding parse/read/route functions | Same batch-invalid/unmapped wrapper and HTTP-only inference | Group/payer plus member ID or name rules remain native; invalid/unmatched rows remain individual failures. Optional DOS/CPT and name fallback remain unchanged. |
| Availity | `availity/input.ts`, project configuration, `services/row-validator.js`, existing selection functions | Service duplicated required-field/date/provider validation and rule parsing | Existing project mapping/defaults/preprocessing and row validation remain shared. Provider errors stay in the native row path; bad rule configuration remains fatal. |
| Blue Shield | `blue-shield/input.ts`: `parseBlueShieldInput`, `readBlueShieldInputWorkbook`, `routeBlueShieldRowsByCredentials`, `createUniqueMemberWorkItems` | Invalid/unmatched rows rejected before worker; separate scope inference | Native group/member/DOS checks, IUMG shared-account mapping, member/DOS deduplication and checkpoint settings remain. Invalid/unmatched rows generate output errors; no routable rows can still be fatal after that output is recorded. |
| Cigna | `cigna/input.ts`: `parseCignaInput`, `readCignaInputWorkbook`; existing per-row processor | Blanket rejection of native invalid statuses/count differences | Native member, name, CPT and date rules remain per row. Name splitting, member/TIN cleanup, date normalization and default login URL remain unchanged. |
| IEHP | `iehp/input.ts`: `parseIehpClaimStatusInput`, `getIehpClaimSearchFields`; existing date/row checks | Pre-worker member/DOS batch rejection; empty cells could hide valid aliases | Native row skips, serial/ISO/slash date handling, CPT/modifier/RA processing and original indexes remain. Missing cells stay absent in encoded workbooks. |
| Kaiser | `kaiser/input.ts`: `parseKaiserInput`, `readKaiserInputWorkbook`; existing per-row processor | Blanket rejection of native invalid statuses/count differences | Native member/DOS/CPT validation remains per row; existing date/member/CPT normalization is unchanged. |
| Medpoint | `medpoint/input.ts`: `parseMedpointInput`, `readMedpointInputRowsFromBuffer` | Native fatal parsing ran inside the service endpoint, with extra count/empty checks | Missing required name/date data **still fails the job** in the shared reader, before browser execution. Name splitting and service-to-date fallback remain. This was not converted into partial processing. |
| My Family | `my_family/input.ts`: `parseMyFamilyInput`, `readMyFamilyInputWorkbook`; existing per-row processor | Blanket rejection of native invalid statuses/count differences, bypassing worker fallback behavior | Native DOS checks, member/name fallbacks and the worker's treatment of missing identity fields remain authoritative. |
| Optum Pro | `backend/src/scrapers/optum-pro/input.ts`: `parseOptumProInput`, `readOptumProInputRowsFromBuffer` | Native fatal parsing and count enforcement ran before job creation | Missing medical group/patient/DOS/CPT **still fails the job** in the shared reader. Existing optional fields, member cleanup and credential defaults remain. |
| Physicians | `physicians/input.ts`: `parsePhysiciansInput`, `readPhysiciansInputWorkbook`; existing per-row processor | Blanket rejection of native invalid statuses/count differences | Native member/DOS validation remains per row; from/to dates, authorization and provider-claim aliases remain unchanged. |
| Regal | `regal/input.ts`: `parseRegalInput`, `readRegalClaimRowsFromBuffer` | Native fatal parsing plus count/empty enforcement ran before worker | Required header/incomplete-row errors **still fail the job**. Group/name/date normalization, account numbers, start index and MFA preferences remain. |
| UHC | `uhc/claim-status-job.ts`: `prepareUhcAutomationRun`; `uhc/runtime-input.ts`: `prepareUhcRuntimeClaims`; `uhc/workbook-output.ts`: `parseUhcClaimRows` | Service pre-parsed claims, enforced row-count equality and saved a separately normalized sidecar | Native required-header/missing-Group failures remain fatal; rows without subscribers retain native filtering. Worker date validation, client-type defaults, provider mappings and OTP/provider-selection prompts remain unchanged. |
| Waystar | `waystar/input.ts`: `parseWaystarInput`, `parseWaystarClaimWorkbook` | Any entry in native `invalidRows` caused a service-wide rejection | Valid and invalid collections reach the existing worker. Invalid rows become error-sheet entries; valid rows continue. Patient/payer/date aliases, date defaults and verification answers remain unchanged. |

No active implementation or registry entry named TMRV was found. A portal cannot be claimed as covered under that name until its actual implementation is identified. The registry coverage test prevents silently omitting any currently registered portal.

## 4. Shared boundary after the changes

```text
Manual claim/login workbook ---------------------------+
                                                      |
AR JSON -> envelope/scalar parser                      |
        -> shared transport-only workbook encoder -----+
                                                      v
                                 Same native worker input parser
                                                      v
                                Existing canonical flat claim rows
                                                      v
                         Shared portal normalization / validation
                                                      v
                         Shared credential routing / automation
                                                      v
                                  Existing output workbook
```

The existing flat, header-keyed row records and native portal row types are reused. No second domain model or source-dependent portal validator was introduced. All claim workbooks now use `encodeServiceClaimWorkbook`, retaining original field names and scalar types and adding correlation metadata. Absent/null cells stay absent, allowing native alias fallback. Portal mapping, validation, filtering and conversion are no longer executed by the service adapter.

For Aerial, the shared reader now ignores correlation columns before positional fallback, preserving physical A/H/K legacy positions. It also handles separator/casing header aliases previously accepted only by the JSON converter. This preserves accepted AR aliases while giving uploaded workbooks the same interpretation. Native column precedence, required data and row handling remain authoritative.

## 5. Credential-scope compatibility

AR previously allowed one account to omit its group/payer when a unique scope could be inferred. Removing API-side claim parsing must not break that accepted contract.

The encoder now writes an explicit internal login-workbook instruction for each omitted scope: `__infer_group_from_claims` / `__infer_payer_from_claims`. `credential-scopes.ts`, `resolveClaimCredentialScopes`, resolves that instruction inside the shared worker input parsers for Aerial, All Care, Astrona and Blue Shield. This is an input instruction, not a manual/service source flag; a workbook from either transport uses the same resolver.

Ordinary manual login workbooks contain no instruction and retain their existing required-scope validation. Explicit canonical account scopes are never overwritten. Scope inference uses the native readers' fields and prefers rows native validation permits routing, so an invalid claim cannot make the scope of otherwise runnable rows ambiguous. If every row is invalid, any unique supplied scope is retained so native row failures can still be recorded. Ambiguous defaults require explicit credential scopes instead of guessing an account. Existing multi-account routing stays native and is covered by independent fixtures.

## 6. Bugs corrected versus legitimate differences

The bugs were service-only promotion of row failures to request failures, additional count/filter rejection, early business parsing/routing, duplicated Aerial aliases, and missing-cell encoding that changed alias behavior. These have been removed or moved to the shared native implementation.

Legitimate transport/service-contract differences remain:

- User versus bearer-token authentication; client-system matching, execution IDs, idempotency and deadlines.
- Uploaded versus generated filenames; manual resume positions versus an initial AR submission starting at zero.
- A 1–10,000 JSON claim-array limit, unique nonempty client row references, scalar cell shapes, field-count/name limits and protected result/correlation columns.
- Credential object/account structure, existing required credential values/lengths, single-account restrictions for readers that only consume one account, and explicit scopes for ambiguous multi-account requests.
- JSON structure/limits for Waystar verification answers and Blue Shield's allowed mail-configuration fields. Native credential parsing and application of configuration remain in the worker.
- AR correlation, pagination and outcome aggregation. A service job may report `partial_success` while a manual run reports processing `completed` and records failed/skipped claims in its workbook. Existing cancellation reconciliation, output-storage requirements and deadline handling are unchanged.

## 7. Files/functions changed in the remaining-portal iteration

| File | Change |
| --- | --- |
| `backend/src/aws/service/generic-claim-status-input.ts` | `prepareGenericClaimStatusServiceInput` now encodes only. Removed native reader/routing calls, row-count rejection, Aerial alias conversion and obsolete required-claim metadata. Preserve credential contract, login sheets, form fields and correlation. |
| `backend/src/aws/service/claim-status-workbook-validation.ts` | Removed from production. Deleted blanket invalid/unmapped-row rejection. |
| `backend/src/aws/service/portal-input-test-helpers.ts` | Native-reader projections retained only for tests, without imposing service-only validation rules. Includes Waystar valid and invalid collections. |
| `backend/src/workflows/claim-status/credential-scopes.ts` | New shared internal scope instruction/resolver. |
| `backend/src/workflows/claim-status/portals/aerial/input.ts` | `parseAerialInput` resolves optional scope instructions in shared worker preparation. |
| `backend/src/workflows/claim-status/portals/aerial/workbook.ts` | Shared header normalization and transport-metadata handling; preserve sparse positions and legacy fallback. |
| `backend/src/workflows/claim-status/portals/all-care/input.ts` | `parseAllCareInput` resolves optional scope instructions. |
| `backend/src/workflows/claim-status/portals/astrona/input.ts` | `parseAstronaInput` resolves optional scope instructions. |
| `backend/src/workflows/claim-status/portals/blue-shield/input.ts` | `parseBlueShieldInput` resolves optional scope instructions before existing configuration/routing. |
| `backend/src/aws/service/portal-input-parity.test.ts` | Expand from valid cases to missing-field, mixed-batch, filtered-row, reservation/retry, routing, inference, legacy Aerial, deduplication and registry coverage. |
| `backend/src/aws/service/generic-claim-status-service.test.ts` | Replace obsolete ingestion-rejection expectations; add per-portal result/reference/partial-success regressions. |
| `backend/src/aws/service/availity-iehp-input-parity.test.ts` | Extend HTTP authentication gating checks across every registered service portal. |
| `docs/claim-status-submission-parity.md` | This complete report. The first-iteration report now links here. |

The earlier Availity/IEHP input/encoder changes remain in place. `service-jobs.ts`, worker execution loops, portal selectors, public API fields and database schemas were not changed.

## 8. Verification

- Final run covering parity, result mapping, shared worker submission behavior and all affected native parser suites: **203/203 passed** across 10 files.
- The independent transport suite now has **82 passing cases**, including valid input, one invalid row and valid/invalid/valid batches for each of the remaining 13 portals, and a registry completeness assertion.
- Broader run across 51 test files: **443 passed, 4 failed, 447 total**. This ran before the final additional compatibility/inference fixtures; affected suites were subsequently rerun in the 203-test passing run.
- The four broader failures are existing assertions in unchanged modules: three in Availity project configuration (extra output headers, current ICM organization name, current Dumont mapping), and one Regal credential assertion that omits optional properties whose actual values are `undefined`. The implementation/configuration and tests for those failures match HEAD. No portal behavior was changed to make them pass.
- Existing regression coverage for authentication, reservation/idempotency/token rotation, service results/cursors, 10,000-row artifacts, packaging, OTP and provider prompts passed. New result-mapping cases verify every generic portal retains client references, multiple detail rows and partial-success classification.
- ESLint passed on 16 new/refactored TypeScript files. The touched legacy Aerial workbook module still has its three pre-existing lint errors (`require` import and two explicit `any` types in unchanged output helpers). `git diff --check` passed.
- Repository typecheck reports only the existing errors in untouched All Care/Astrona/Blue Shield test code, eligibility test code and Ebridge's missing `DownloadDocument` type; no changed file reported an error.
- Tests use local fixtures/mocks; no production portals or AWS jobs were launched. The separate Waystar browser-navigation fixture was excluded. An initial sandbox startup error required running the regression runner outside that sandbox.

## 9. Limits, deployment and rollback

Native fatal validation is intentionally preserved for Regal, Medpoint, Optum Pro, UHC's fatal conditions, malformed credentials and unusable job configuration. Parity does not mean every portal supports partial processing.

Native readers also intentionally filter some rows that have no usable search fields. Both transports now use those same filters; the AR envelope no longer rejects the entire batch because the parsed count differs. AR retains every submitted client reference. If a native reader drops a row and emits no result for it, existing normalization can leave that reference `INCOMPLETE`; this refactor does not invent a successful or failed portal result. Changing this would require a separately reviewed change to native filtering/output semantics.

Deploy the backward-compatible worker image **before** the service HTTP bundle. Older workers cannot interpret the new scope-inference workbook instructions. Alternatively, require explicit group/payer scopes during a mixed-version rollout. For rollback, revert the service encoder before reverting worker support. There is no database/API migration. No deployment or live portal verification has been performed by this task.

## 10. Confirmation

All currently registered Claim Status portals now route equivalent claims and resolved account scopes through the same native portal preparation, validation, filtering, credential routing and execution implementation for manual and AR submissions. HTTP ingestion no longer adds claim-business rejection ahead of that path. Independent fixtures cover both the row-error and legitimately fatal cases.

This confirms the shared code path and tested behavior, not identical transport responses, identical job-status presentation or guaranteed live portal outcomes. No parity claim is made for other workflows or an unregistered TMRV implementation.
