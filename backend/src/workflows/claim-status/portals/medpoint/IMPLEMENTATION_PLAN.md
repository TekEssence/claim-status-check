# Medpoint Portal Implementation Plan

## Current State

Medpoint already exists on the frontend claim status side:

- portal card and route are present
- upload form is present
- forced portal page is present

Backend automation is not connected yet:

- Medpoint is not registered in `backend/src/workflows/claim-status/registry.ts`
- no Medpoint scraper module exists yet under `backend/src/workflows/claim-status/portals/medpoint/`

This plan covers the first implementation milestone for Medpoint claim status automation using the HTML tag notes provided from the portal.

## Source Notes From Portal Tags

Known portal elements from the provided Medpoint notes:

- login username input uses `formcontrolname="username"`
- login password input uses `formcontrolname="password"`
- login requires reCAPTCHA interaction
- sign-in button contains text `Sign in`
- OTP input uses `name="otp"` with `aria-label="Enter OTP"`
- post-login validation button exists near the OTP flow
- claim search uses:
  - `Member Last Name`
  - `Member First Name`
  - `Service From Date`
  - `Service To Date`
- claims are opened from a claim-number link
- detail page includes:
  - claim number
  - check
  - date received
  - date paid
  - patient account number
  - provider name
  - `Details` section
  - `Code Details` section

Additional business rules from the notes:

- some claims need a double-click on the claim number link to open details
- for DOS in 2026, the active IPA should be `Optum Care Network-Inland Faculty Medical Group`
- for DOS in 2024 or 2025, the active IPA should be `OIFMG HISTORY`
- if the `Net` amount is greater than zero, output status should be treated as paid
- if the `Net` amount is zero, the claim should be treated as denied and the denial code/description must be taken from `Code Details`
- subtotal rows inside the `Details` table must not be included in output

## Scope Of First Implementation

The first Medpoint milestone should include:

1. Register Medpoint in the backend claim-status registry.
2. Create Medpoint-specific input, credential, portal, scraper, and output modules.
3. Support login from uploaded credential workbook.
4. Support claim search from uploaded input workbook.
5. Support manual reCAPTCHA pause in headed local runs.
6. Support OTP entry through the existing job input-request flow.
7. Search claims by member name and service-date range.
8. Open claim details and extract status information.
9. Extract detail rows while excluding subtotals.
10. Derive final status using `Net` and `Code Details`.
11. Emit a Medpoint output workbook plus audit and error sheets.

## Proposed File Structure

New backend files:

```text
backend/src/workflows/claim-status/portals/medpoint/
├── IMPLEMENTATION_PLAN.md
├── credentials.ts
├── input.ts
├── output.ts
├── portal.ts
├── scraper.ts
├── types.ts
└── tests/
    ├── credentials.test.ts
    ├── input.test.ts
    └── status-mapping.test.ts
```

Files to update:

```text
backend/src/workflows/claim-status/registry.ts
```

Possible frontend updates only if needed later:

```text
frontend/src/workflows/claim-status/ClaimStatusPage.tsx
frontend/src/workflows/claim-status/portals/medpoint/MedpointInputForm.tsx
```

## Implementation Phases

## Phase 1: Backend Registration

- Add `medpointScraper` import to `backend/src/workflows/claim-status/registry.ts`.
- Register `medpoint` in `claimStatusPortalRegistry`.
- Confirm `/api/scrape-jobs` can resolve `portalId=medpoint`.

Definition of done:

- backend accepts Medpoint as a valid claim-status portal
- job creation no longer fails with unknown portal for Medpoint

## Phase 2: Credential Workbook Parsing

Create `credentials.ts` to read login workbook values.

Expected fields to support by flexible header matching:

- `url`
- `login url`
- `portal url`
- `username`
- `user name`
- `password`

Parsing behavior:

- accept `.xlsx`, `.xls`, or `.csv` through the existing upload
- read the first non-empty credential row
- trim values
- default login URL from env or a Medpoint constant if workbook URL is blank
- throw a clear validation error if username or password is missing

Definition of done:

- credentials are normalized into a Medpoint credential object
- parser has unit tests for common header variants

## Phase 3: Claim Input Workbook Parsing

Create `input.ts` to read Medpoint claim-search rows.

Likely minimum input fields based on portal search controls:

- member last name
- member first name
- service from date
- service to date

Recommended optional fields to preserve if present:

- claim number
- patient account
- dos
- row notes

Parsing behavior:

- normalize names
- normalize dates into a portal-safe format
- preserve original row number for output tracing
- reject blank rows
- capture validation errors per row when required fields are missing

Definition of done:

- input parser returns validated Medpoint search rows
- date normalization is covered by tests

## Phase 4: Login Flow

Create `portal.ts` functions for Medpoint login.

Planned automation steps:

1. Open Medpoint login URL.
2. Wait for username field using `formcontrolname="username"`.
3. Fill username.
4. Fill password using `formcontrolname="password"`.
5. Detect reCAPTCHA area.
6. In local headed mode, pause and hand control to the user for reCAPTCHA completion in the real Medpoint session.
7. Click `Sign in`.
8. Wait for either OTP input, a logged-in page, or an error state.

Notes:

- reCAPTCHA should not be treated as auto-solvable
- local/manual flow is the safe first implementation
- if deployed/headless execution cannot pass reCAPTCHA, the scraper should fail with a clear explanation

Definition of done:

- login reaches OTP or post-login landing page consistently in local testing

## Phase 4A: Human-In-The-Loop reCAPTCHA Handoff

The recommended UX is to pause automation and let the user complete reCAPTCHA in the real Medpoint browser session, not by rebuilding the captcha inside our own app.

Recommended product behavior:

1. Playwright opens Medpoint.
2. Playwright fills username and password.
3. Backend emits a job event such as `waiting_for_recaptcha`.
4. Frontend shows a dedicated blocking screen or modal:
   - `Credentials entered`
   - `Please complete "I'm not a robot" in the Medpoint browser window`
   - `Click Completed after Medpoint moves to the next step`
5. User completes reCAPTCHA directly in the live Medpoint page.
6. User clicks `Completed` in our UI.
7. Backend resumes Playwright and checks whether the page advanced successfully.

Important implementation decision:

- do not recreate or simulate the captcha UI inside our product
- do not try to mirror every click from our UI into a fake captcha screen
- keep the user interacting with the real portal session that Playwright already opened

Recommended UI actions:

- `Completed`
- `Cancel Job`
- optional `Retry Check`
- optional `Take Screenshot` for debugging

Recommended backend behavior after `Completed`:

- re-check page state
- confirm captcha step is gone or sign-in can proceed
- continue toward OTP or post-login landing page
- if still blocked, re-show the waiting state with a clear message

Nice-to-have improvement:

- poll portal state while the user is solving reCAPTCHA
- automatically detect when the page advances
- keep `Completed` as the manual fallback even if auto-detection is added

Definition of done:

- the Medpoint run can pause safely at reCAPTCHA
- the frontend exposes a clear human-action-required screen
- Playwright resumes only after the user confirms completion
- no custom captcha clone is built in our UI

## Phase 5: OTP Handling

Implement OTP support using the shared scrape-job input-request pattern.

Planned behavior:

1. Detect OTP field using `name="otp"` or `aria-label="Enter OTP"`.
2. Emit a job input request to the frontend.
3. Wait for OTP submission from the active job.
4. Fill the OTP field.
5. Click the validation button.
6. Confirm Medpoint home page is reached.

Definition of done:

- OTP can be entered from the frontend and submitted back into the running job

## Phase 6: IPA Context Selection

After login, verify the correct IPA context before claim search.

Rules from the portal notes:

- use `Optum Care Network-Inland Faculty Medical Group` for 2026 DOS
- use `OIFMG HISTORY` for 2024 and 2025 DOS

Implementation approach:

- inspect the service year from the input row
- detect the currently displayed IPA text
- if switching is possible in the portal UI, perform the switch before search
- if switching is not possible and the visible IPA does not match the required context, fail that row with a clear message

Definition of done:

- every row is searched under the correct Medpoint IPA context

## Phase 7: Claims Search

Implement claim lookup with the known Medpoint fields.

Planned search steps:

1. Open the `Claims` section.
2. Open the search view.
3. Fill:
   - member last name
   - member first name
   - service from date
   - service to date
4. Submit the search.
5. Wait for either results or no-results state.

Search selectors from notes:

```text
formcontrolname="membLast"
formcontrolname="membFirst"
formcontrolname="serviceFromDate"
formcontrolname="serviceToDate"
```

Definition of done:

- Medpoint returns claim rows for a valid input row
- scraper can detect no-results cleanly

## Phase 8: Result Row Opening

Implement claim result navigation.

Planned behavior:

- extract visible claim-number links from the result list
- first try a regular click
- if detail does not open reliably, use Playwright double-click
- if a stable direct detail `href` is available, prefer direct navigation over fragile row index reuse

Definition of done:

- scraper can open the claim detail view for a selected result row

## Phase 9: Claim Detail Extraction

Extract summary fields from the detail page.

Known fields to capture:

- claim number
- check number
- date received
- date paid
- patient account number
- provider name

Also capture:

- current IPA/context used
- source row number
- searched member/date values

Definition of done:

- detail header fields are parsed into a normalized Medpoint claim record

## Phase 10: Detail Table Extraction

Read the full `Details` section.

Rules:

- capture all claim-line columns from the Medpoint `Details` table
- exclude subtotal rows
- preserve row order

Implementation detail:

- detect table headers dynamically on the live page
- mark rows as subtotal/summary rows by text pattern instead of treating every row as a line item

Definition of done:

- detail lines are extracted cleanly without subtotal pollution

## Phase 11: Code Details Extraction And Status Mapping

Read the `Code Details` section and apply output status rules.

Business rules:

- if `Net > 0`, status becomes paid
- if `Net = 0`, inspect `Code Details`
- denial output should include code and description when available

Planned mapping:

- `final_status = Paid` when net amount is positive
- `final_status = Denied` when net is zero and denial details exist
- preserve raw portal values in output columns for auditability

Definition of done:

- Medpoint output can distinguish paid vs denied using the portal data, not only raw text labels

## Phase 12: Output Workbook

Create `output.ts` to generate `medpoint_output.xlsx`.

Recommended sheets:

```text
Output
Audit Log
Error Log
Run Summary
```

Recommended output columns:

```text
input_row_number
input_member_last_name
input_member_first_name
input_service_from_date
input_service_to_date
input_claim_number
ipa_context
search_result_index
portal_claim_number
portal_check_number
portal_date_received
portal_date_paid
portal_patient_account
portal_provider_name
detail_line_number
detail_raw_status
detail_net_amount
denial_code
denial_description
final_status
bot_notes
```

Definition of done:

- Medpoint run emits an output workbook even when partial rows succeed before a later failure

## Phase 13: Tests

Add focused tests for logic that does not need live browser execution:

- credential header matching
- input header matching
- date normalization
- IPA year routing
- `Net`-based status derivation
- denial extraction mapping
- subtotal filtering

Definition of done:

- Medpoint-specific parsing and status rules are covered by unit tests

## Risks And Notes

- reCAPTCHA is the main automation risk and should be treated as a manual step first
- recreating reCAPTCHA in our UI would be brittle and is not recommended
- the exact selector for the OTP validate button is still unclear from the provided notes and may need live inspection
- the exact structure of the `Details` table and `Code Details` table still needs one portal capture during implementation
- the claim input workbook column names are not yet confirmed, so the parser should be written with flexible header aliases

## Recommended Build Order

1. Add backend registry entry.
2. Scaffold Medpoint backend files.
3. Implement credential parser.
4. Implement input parser.
5. Implement login, manual reCAPTCHA pause, and OTP flow.
6. Implement IPA selection logic.
7. Implement claim search and result navigation.
8. Implement detail extraction.
9. Implement code-detail status mapping.
10. Generate output workbook.
11. Add unit tests.

## What We Still Need Before Finalizing Automation

- exact Medpoint input Excel column names
- live confirmation of the OTP validate button selector
- live confirmation of the `Details` table headers
- live confirmation of the `Code Details` table structure

## Next Step

Review this plan first. After you confirm it, the next coding step should be:

1. scaffold the Medpoint backend portal folder
2. register Medpoint in the backend claim-status registry
3. implement the workbook parsers before browser automation
