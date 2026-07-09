# Claim Status Automation Implementation Plan

## 1. Scope

Build a Playwright-based automation system for Availity claim status lookup.

Current implementation scope:

- Login with username/password.
- Complete TOTP MFA.
- Keep the browser open after login for manual verification.

Next implementation milestone:

- Keep `login.js` as login/MFA-only.
- Create a new production runner, `claim-status.js`.
- Implement Excel read/validation/output/checkpoint foundation.
- Implement Availity navigation to Claim Status.
- Implement Member tab search.
- Implement Member result matching by `Service Date` + `Charges`.
- Implement Member detail extraction for in-process, paid, and denied claims.
- Defer HIPAA Standard search until its field/result HTML is captured.

Final target scope:

- Read input Excel.
- Validate rows.
- Navigate to `Claims & Payments > Claim Status`.
- Search claims in Availity.
- Match result rows by `Service Date` + `Charges`.
- Extract status-specific details.
- Write output workbook with `Input`, `Output`, `Error`, and `Audit_Log` sheets.

Do not use input `Claim No` for matching. It is reference-only because Excel claim numbers do not reliably match portal claim numbers.

## 2. Implementation Strategy

Build the system in thin, testable phases. Do not implement the full final workflow in one pass.

### Phase 1: Login/MFA

Status: implemented in `login.js`.

Rules:

- Keep `login.js` limited to login, MFA, successful-login verification, and browser-open verification.
- Do not add claim status navigation, Excel processing, or extraction logic into `login.js`.

### Phase 2: Member-Only Claim Processing

Create a new runner:

```text
claim-status.js
```

Implement:

- Reuse login/browser utilities.
- Read input Excel.
- Validate input rows.
- Add `input_row_id`.
- Navigate to Claim Status.
- Select payer using mapping.
- Process only Member tab rows where `Group No` is present.
- Match result rows by `Service Date` + `Charges`.
- Extract Member detail pages for in-process, paid, and denied claims.
- Write `Input`, `Output`, `Error`, and `Audit_Log`.
- Write JSON checkpoint after every row.

Recommended folder/module structure for Phase 2:

```text
project-root/
├── claim-status.js
├── login.js
├── config/
│   └── payer-mapping.json
├── pages/
│   ├── login.page.js
│   ├── mfa.page.js
│   ├── navigation.page.js
│   ├── claim-status-member.page.js
│   ├── member-results.page.js
│   └── claim-detail.page.js
├── services/
│   ├── row-validator.js
│   ├── status-normalizer.js
│   └── summary-renderer.js
├── excel/
│   ├── input-reader.js
│   └── output-writer.js
├── checkpoints/
└── utils/
```

This structure keeps `login.js` as a login test runner while `claim-status.js` becomes the claim-processing runner.

Rows where `Group No` is missing during Phase 2:

- Do not process through Member tab.
- Mark as pending HIPAA Standard implementation.
- Set `bot_updated_claim_status_1 = PENDING - HIPAA Standard flow not implemented yet`.
- Set `bot_overall_result = pending_hipaa`.
- Add an `Error` or manual-review row with reason `hipaa_standard_flow_pending`.

### Phase 3: HIPAA Standard Search

Implement after HIPAA Standard HTML is captured.

HIPAA Standard will handle:

- Rows with missing `Group No`.
- Member-tab no-match fallback rows.
- Any payer-specific Member limitations where HIPAA still gives at least main claim status.

### Phase 4: Hardening

Implement after Member and HIPAA paths work:

- Resume from checkpoint.
- `job_id` based reconnect support.
- SSE progress streaming with keepalive pings.
- Better session-expiry recovery.
- Run summary.
- Configurable timeouts/retries.
- Optional headless mode.
- Frontend ExcelJS update/download path if a frontend is part of the deployment.
- Separate local Playwright Chromium and serverless Chromium runtime profiles if serverless deployment is required.

## 3. Current End-To-End Implementation Flow

1. Load config and credentials from `.env.local` and the external env file.
2. Launch Chromium in headed mode.
3. Open Availity login URL.
4. Enter username and password.
5. Complete TOTP MFA.
6. Verify successful login using `SUCCESS_URL_FRAGMENT`.
7. Keep browser open if `KEEP_BROWSER_OPEN=true`.
8. For claim-status automation phase, read the input Excel once.
9. Add `input_row_id` to every row.
10. Validate required fields before using the browser.
11. For invalid rows, skip portal search, write failed output, write error details, and continue.
12. For valid rows, process one row at a time in the same logged-in browser session.
13. Navigate to `Claims & Payments > Claim Status`.
14. Select payer using payer mapping.
15. If payer mapping is missing, mark the row failed and continue.
16. If `Group No` is missing, do not search in this milestone. Mark the row as pending HIPAA Standard implementation and continue.
17. If `Group No` is present, search the `Member` tab.
18. In Member search, fill provider, member ID, group number, and service dates.
19. Submit search.
20. Read all result rows.
21. Match rows where portal `Service Dates` equals input `Service Date` and portal `Billed Amount` equals input `Charges`.
22. If no Member rows match after both provider attempts, mark the row as pending HIPAA Standard implementation. Do not search HIPAA Standard in this milestone.
23. For every matched row, read status from the search result row first.
24. If status is unsupported, extract claim number and status from the search results row only, write summary, and do not open the detail page.
25. If status is supported, click the matched row to open detail page.
26. Run the extractor based on status:
    - `IN PROCESS`, `IN-PROCESS`, `PENDING`: in-process extractor.
    - Paid status: paid extractor.
    - Denied status: denied extractor.
27. Write each matched claim summary into `bot_updated_claim_status_1` through `bot_updated_claim_status_5`.
28. After each detail extraction, click `Return to Results`.
29. Continue until all matched rows for that input row are processed.
30. Write/update JSON checkpoint after every row.
31. Write interim Excel every configured batch size, default `10`.
32. Write final Excel after all rows complete.

Implementation note:

- The above is the current implementation flow.
- HIPAA Standard is not executed yet.
- HIPAA Standard remains a future extension after its HTML and behavior are documented.

## 4. Input Workbook

Exact input columns:

- `Payer Name`
- `Patient Name`
- `Patient Acct No`
- `Patient DOB`
- `Group No`
- `Subscriber No`
- `Claim Date`
- `Service Date`
- `Last Claim Status Change Date`
- `Claim No`
- `Charges`
- `Claims Not Submitted`
- `Current`
- `Balance`

Required fields for validation:

- `Payer Name`
- `Subscriber No`
- `Group No`
- `Service Date`
- `Charges`

Current Member-only search fields:

- `Payer Name`
- `Subscriber No`
- `Group No`
- `Service Date`
- `Charges`

Deferred HIPAA behavior:

- In the final target flow, `Group No` can be optional for HIPAA Standard.
- In the current Member-only milestone, `Group No` is required because Member search requires it.
- If `Group No` is missing now, mark the row invalid/pending HIPAA until HIPAA Standard implementation is added.

Currently not required for Member search:

- `Patient Name`
- `Patient DOB`

Reference-only field:

- `Claim No` is preserved in output/error/audit but is not used for matching.

## 5. Input Validation

Validation runs before browser processing.

Validation rules:

- `Payer Name` must be present.
- `Subscriber No` must be present.
- `Group No` must be present for the current Member-only implementation.
- `Service Date` must be present in `MM/DD/YYYY` format.
- `Charges` must be present.
- Payer mapping must exist.

Invalid row behavior:

- Set `validation_status=invalid`.
- Set `validation_message` with the reason.
- Do not search in Availity.
- Add failed row to `Output`.
- Add detailed row to `Error`.
- Continue to next input row.

Valid row behavior:

- Set `validation_status=valid`.
- Leave `validation_message` blank.
- Continue to portal search.

## 6. Payer Mapping

Excel payer names may not match Availity dropdown names.

Use the payer mapping workbook in the project folder:

```text
Payer_mapping_ava.xlsx
```

Mapping columns:

- `Payer name in excel`: payer name as it appears in the input Excel.
- `Payer name in website`: payer name to search/select in the Availity payer dropdown.

Mapping rule:

- Read input row `Payer Name`.
- Trim whitespace.
- Find an exact trimmed match in `Payer_mapping_ava.xlsx` column `Payer name in excel`.
- Use the corresponding `Payer name in website` value for the Availity payer dropdown.
- If no mapping is found, do not search the row.

If mapping is missing:

- Do not search the row.
- Set `bot_updated_claim_status_1 = FAILED - Payer mapping not found`.
- Set `bot_overall_result = failed`.
- Add `Error` reason `payer_mapping_not_found`.
- Continue to next row.

## 7. Output Workbook

Workbook sheets:

- `Input`
- `Output`
- `Error`
- `Audit_Log`

### Input Sheet

Contains:

- `input_row_id`
- all original input columns
- `validation_status`
- `validation_message`

### Output Sheet

One output row per input row.

Columns:

- `input_row_id`
- all original input columns
- `bot_updated_claim_status_1`
- `bot_updated_claim_status_2`
- `bot_updated_claim_status_3`
- `bot_updated_claim_status_4`
- `bot_updated_claim_status_5`
- `bot_updated_time`
- `bot_search_source_tab`
- `bot_match_count`
- `bot_overall_result`
- `bot_notes`

Status-cell formatting rule:

- Always start with `Claim Number`.
- Second line is always `Claim Status`.
- Claim-level fields come next.
- Add a blank line.
- Add one CPT line per line if applicable.
- Do not write dense single-line dumps.

Standard format:

```text
Claim Number: <claim_number>
Claim Status: <claim_status>
<claim-level-field>: <value>

<cpt_code> -> <field>: <value> | <field>: <value>
<cpt_code> -> <field>: <value> | <field>: <value>
```

Missing optional field rule:

- Missing optional/non-applicable fields must not fail the row.
- Leave missing values blank in the summary.
- Add missing-field notes to `bot_notes`.

Claim not found output rule:

- If Member search fails for both configured providers, update the main output row.
- Set `bot_updated_claim_status_1` to:

```text
FAILED - Claim not found in Member tab for matching Service Date and Charges. HIPAA Standard search not implemented yet.
```

- Set `bot_overall_result` to `pending_hipaa`.
- Set `bot_notes` with the searched provider names and portal no-results message.
- Add detailed row to `Error` with `failure_reason=claim_not_found_in_member_provider_attempts`.

### Error Sheet

Contains row-level failures and recoverable processing failures.

Suggested columns:

- `run_id`
- `input_row_id`
- `payer_name`
- `claim_no`
- `service_date`
- `charges`
- `search_source_tab`
- `failure_stage`
- `failure_reason`
- `current_url`
- `needs_manual_review`

Current implementation rule:

- Do not capture screenshots.
- Do not capture HTML snapshots.
- Write clear error messages into the `Error` sheet and concise failure status into the `Output` sheet.

### Audit_Log Sheet

Technical run trace.

Suggested columns:

- `run_id`
- `timestamp`
- `input_row_id`
- `payer_name`
- `claim_no`
- `step`
- `status`
- `duration_ms`
- `retry_count`
- `message`

Do not log credentials, TOTP secret, generated OTP, or unnecessary PHI.

## 8. Processing And Checkpoint Strategy

Processing model:

- Process sequentially, one row at a time.
- Do not use concurrent browser sessions initially.
- Batch means output/checkpoint synchronization, not parallel claim processing.
- Read input workbook once at the start.
- Store results in memory.
- Write JSON checkpoint after every row.
- Write interim Excel every `EXCEL_WRITE_BATCH_SIZE`, default `10`.
- Write final Excel at end.
- Never modify the original input workbook.

Suggested files:

```text
claim_status_checkpoint_<run_id>.json
claim_status_output_partial_<run_id>.xlsx
claim_status_output_<run_id>.xlsx
```

Checkpoint state fields:

- `job_id`: stable id for the run, used by frontend/SSE reconnects.
- `start_index`: first row index of the current batch.
- `current_claim`: current input row/claim index being processed.
- `completed_input_row_ids`: completed rows.
- `failed_input_row_ids`: failed rows.
- `last_event_sequence`: last emitted event number for SSE replay/reconnect.

Batch progress rule:

- Processing is sequential inside each batch.
- `current_claim` updates as each row starts/completes.
- `start_index` is advanced only after the full batch completes.
- If a batch crashes midway, resume from `current_claim`, not from the next batch.
- When the batch completes, sync `start_index` to the next unprocessed row.

Resume behavior:

- Load checkpoint.
- Skip completed `input_row_id` values.
- Continue from next unprocessed row.
- Rebuild Excel from checkpoint data.
- If the frontend reconnects using `job_id`, continue streaming messages for the same job.
- If SSE disconnects, frontend calls reconnect endpoint with `job_id` and last received event sequence.

Failure behavior:

- Row-level failures do not stop the run.
- Unrecoverable run-level failures can stop the run:
  - repeated login/MFA failure
  - portal outage
  - bot block/CAPTCHA
  - unrecoverable browser crash

Frontend Excel handling:

- The frontend may convert the uploaded `.xlsx` into an ExcelJS workbook to preserve formatting.
- Backend should return structured row updates, not rewrite the original uploaded workbook directly.
- Frontend can apply updates to the ExcelJS workbook and write/download the final workbook while preserving formatting where possible.
- For large files, backend should still maintain JSON checkpoints as the source of truth for recovery.

SSE progress streaming:

- Backend creates a `job_id` for every run.
- Frontend listens using SSE, preferably with `fetchEventSource`.
- Backend sends regular ping/keepalive messages so the connection stays active.
- Backend emits events for:
  - job started
  - row validation started/completed
  - row processing started/completed/failed
  - checkpoint written
  - batch completed
  - interim output ready
  - job completed
  - job failed
- If SSE disconnects, frontend reconnects with the same `job_id`.
- Backend resumes streaming from the same job and, where possible, from the last event sequence.

Runtime environment:

- Local system: use normal Playwright Chromium.
- Vercel/serverless: use a serverless-compatible Chromium package.
- Preferred production approach is still a local machine or dedicated VM because payer portals, MFA, long sessions, downloads, and browser persistence are not ideal for serverless.
- Serverless should be treated as a separate deployment profile, not the first implementation target.

## 9. Member Tab Search Flow

All HTML in this section applies to Member tab search only. HIPAA Standard has a different procedure and will be documented later.

Member path is used only when `Group No` is present.

1. Select payer.
2. Select Member tab.
3. Select provider `TRINITY PAIN MANAGEMENT`.
4. Verify Provider NPI auto-populates.
5. Fill Member ID from `Subscriber No`.
6. Fill Group Number from `Group No`.
7. Fill Service From Date from `Service Date` using `MM/DD/YYYY`.
8. Verify Service To Date auto-fills with same date.
9. If To Date is empty, fill it manually.
10. Click Search.
11. Match rows by `Service Dates` + `Billed Amount`.
12. If matching rows are found, extract them.
13. If no matching rows are found, change provider to `DAO, THUAN DUC`.
14. Re-verify Provider NPI auto-populates.
15. Ensure all required fields remain filled:
    - Member ID
    - Group Number
    - Service From Date
    - Service To Date
16. Click Search again.
17. Match rows by `Service Dates` + `Billed Amount`.
18. If matching rows are found, extract them.
19. If still no matching rows are found, mark the row as pending HIPAA Standard implementation with reason `claim_not_found_in_member_provider_attempts`.

Portal no-results message:

```html
<li>The payer could not find any results based on your search. Please refine your search criteria</li>
```

No-results rule:

- After each Member search, check whether this message appears.
- If it appears for `TRINITY PAIN MANAGEMENT`, retry the Member search using `DAO, THUAN DUC`.
- If it appears again for `DAO, THUAN DUC`, mark the row as pending HIPAA Standard implementation. Do not search HIPAA Standard in this milestone.
- Use failure reason `claim_not_found_in_member_provider_attempts`.
- Still update `bot_updated_claim_status_1`, `bot_overall_result`, `bot_notes`, and `Error`.

For every matched row:

1. Read claim status from result row.
2. If status is unsupported, extract claim number and claim status from the result row only.
3. If status is supported, click matched row.
4. Extract status-specific details.
5. Click Return to Results.
6. Repeat for each matched row.

Provider attempt order:

1. `TRINITY PAIN MANAGEMENT`
2. `DAO, THUAN DUC`

Member search failure reasons:

- `provider_npi_not_populated`
- `service_date_entry_failed`
- `member_search_submit_failed`
- `matching_dos_and_charge_not_found_in_member_results`
- `claim_not_found_in_member_provider_attempts`
- `return_to_results_failed`

## 10. Status Extraction Rules

### In Process / Pending

Statuses:

- `IN-PROCESS`
- `PENDING`

Extract:

- Claim Number
- Claim Status
- Received Date

Summary:

```text
Claim Number: <claim_number>
Claim Status: IN-PROCESS
Received Date: <received_date>
```

Do not expect CPT-level information, check number, paid amount, denial reason, or payment fields.

### Unsupported Status

Supported statuses:

- `IN PROCESS`
- `IN-PROCESS`
- `PENDING`
- `DENIED`
- `PAID`

If any other status appears:

- Do not click/open the detail row.
- Extract claim number from the search results row.
- Extract claim status from the search results row.
- Write only those two values into the next `bot_updated_claim_status_N` cell.
- Add a note to `bot_notes` that the status is unsupported for deep extraction.

Summary:

```text
Claim Number: <claim_number>
Claim Status: <unsupported_status>
```

### Paid

Extract claim-level:

- Claim Number
- Claim Status
- Check Number
- Check Date

Extract CPT-level:

- Procedure Code
- Service Dates
- Billed
- Paid
- Coinsurance
- Copay
- Deductible
- Status if available
- HIPAA Codes if available
- Modifier if available
- Quantity if available

For each CPT line:

- Click expand button.
- Extract expanded values.
- Missing optional values do not fail the row.

Summary:

```text
Claim Number: <claim_number>
Claim Status: PAID
Check Number: <check_number>
Check Date: <check_date>

99204 -> Service Dates: 04/16/2026-04/16/2026 | Billed: $1,050.00 | Paid: $0.00 | Coinsurance: $0.00 | Copay: $0.00 | Deductible: $180.49 | Status: <status> | HIPAA Codes: <codes> | Modifier: <modifier> | Quantity: 1
```

### Denied

Extract claim-level:

- Claim Number
- Claim Status

Extract CPT-level:

- Procedure Code
- Reason/Remark Code
- Matching Reason/Remark Description

For each CPT:

1. Extract the CPT-level `Reason/Remark Codes` value.
2. In the Codes table, find the row where `Code` equals that value.
3. Extract only that matching row's `Description`.
4. If `Show more...` exists, click it before reading the full description.
5. Repeat for every CPT line.

Summary:

```text
Claim Number: <claim_number>
Claim Status: DENIED

G9744 -> Remark Code: M22 | Description: Services provided are covered up to the allowed amount...
```

## 11. HTML And Selector Reference

Generated Material UI `css-*` classes are not stable. Prefer stable `id`, `name`, `role`, `type`, `title`, label text, and visible text.

### Login Page

User ID:

```html
<input aria-invalid="false" aria-describedby="userId-helper-text" id="userId" placeholder="Enter your user ID." aria-required="true" class="MuiInputBase-input MuiOutlinedInput-input MuiInputBase-inputSizeSmall css-1rs2inw" type="text" name="userId">
```

Selector:

```js
"input#userId[name='userId']"
```

Password:

```html
<input aria-invalid="false" aria-describedby="password-helper-text" id="password" placeholder="Enter your password." aria-required="true" class="MuiInputBase-input MuiOutlinedInput-input MuiInputBase-inputSizeSmall MuiInputBase-inputAdornedEnd css-f4w2iy" type="password" name="password">
```

Selector:

```js
"input#password[name='password']"
```

Sign In:

```html
<button class="MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton-containedPrimary MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorPrimary MuiButton-disableElevation MuiButton-fullWidth MuiButton-root MuiButton-contained MuiButton-containedPrimary MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorPrimary MuiButton-disableElevation MuiButton-fullWidth css-1gsaud1" tabindex="0" type="submit">Sign In</button>
```

Selector:

```js
"button:has-text('Sign In')"
```

### MFA

Authenticator option:

```html
<input class="PrivateSwitchBase-input css-j8yymo" type="radio" value="Authenticate me using my Authenticator app" name="choice">
```

Selector:

```js
"input[name='choice'][value='Authenticate me using my Authenticator app']"
```

MFA Continue:

```html
<button class="MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton-containedPrimary MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorPrimary MuiButton-disableElevation MuiButton-root MuiButton-contained MuiButton-containedPrimary MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorPrimary MuiButton-disableElevation css-xxuw44" tabindex="0" type="submit">Continue</button>
```

Selector:

```js
"button:has-text('Continue')"
```

OTP input:

```html
<input aria-invalid="false" aria-describedby="code-helper-text" id="code" class="MuiInputBase-input MuiOutlinedInput-input MuiInputBase-inputSizeSmall css-1rs2inw" type="text" name="code">
```

Selector:

```js
"input#code[name='code']"
```

### Navigation

Claims & Payments:

```html
<button class="NavDropdown__trigger" type="button" aria-haspopup="true" aria-expanded="true" aria-label="Claims &amp; Payments">Claims &amp; Payments<span class="NavDropdown__trigger-icon NavDropdown__trigger-icon--right"><svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" class="NavDropdownChevron" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg" style="transform: rotate(180deg);"><path d="M207.029 381.476L12.686 187.132c-9.373-9.373-9.373-24.569 0-33.941l22.667-22.667c9.357-9.357 24.522-9.375 33.901-.04L224 284.505l154.745-154.021c9.379-9.335 24.544-9.317 33.901.04l22.667 22.667c9.373 9.373 9.373 24.569 0 33.941L240.971 381.476c-9.373 9.372-24.569 9.372-33.942 0z"></path></svg></span></button>
```

Selector:

```js
"button.NavDropdown__trigger[aria-label='Claims & Payments']"
```

Claim Status:

```html
<div title="Claim Status" class="NavLinkItem__link--content">Claim Status</div>
```

Selector:

```js
"div.NavLinkItem__link--content[title='Claim Status']"
```

### Claim Status Page

Payer dropdown:

```html
<div class="payer-select__input-container css-vcw2c9" data-value=""><input class="payer-select__input" aria-controls="" autocapitalize="none" autocomplete="off" autocorrect="off" id="payer" spellcheck="false" tabindex="0" type="text" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-errormessage="" role="combobox" aria-activedescendant="" aria-describedby="react-select-3-placeholder" value="" style="color: inherit; background: 0px center; opacity: 1; width: 100%; grid-area: 1 / 2; font: inherit; min-width: 2px; border: 0px; margin: 0px; outline: 0px; padding: 0px;" aria-invalid="true"></div>
```

Selector:

```js
"input#payer[role='combobox']"
```

Member tab:

```html
<button class="MuiButtonBase-root MuiTab-root MuiTab-textColorSecondary Mui-selected css-1kxyxny" tabindex="0" type="button" role="tab" aria-selected="true">Member</button>
```

Selector:

```js
"button[role='tab']:has-text('Member')"
```

Provider dropdown:

```html
<input aria-invalid="false" aria-describedby=":rk:-helper-text" autocomplete="off" id=":rk:" placeholder="Select..." type="text" aria-required="false" class="MuiInputBase-input MuiOutlinedInput-input MuiInputBase-inputSizeSmall MuiInputBase-inputAdornedEnd MuiAutocomplete-input MuiAutocomplete-inputFocused css-f4w2iy" aria-autocomplete="list" aria-controls="" aria-expanded="false" autocapitalize="none" spellcheck="false" role="combobox" value="">
```

Selector strategy:

```js
"input[role='combobox'][placeholder='Select...']"
```

Provider values:

```text
TRINITY PAIN MANAGEMENT
DAO, THUAN DUC
```

Provider NPI:

```html
<input aria-invalid="false" aria-describedby="providerNpi-helper-text" id="providerNpi" name="providerNpi" readonly="" type="text" aria-required="true" class="MuiInputBase-input MuiOutlinedInput-input MuiInputBase-inputSizeSmall Mui-readOnly MuiInputBase-readOnly css-1rs2inw" value="">
```

Selector:

```js
"input#providerNpi[name='providerNpi']"
```

Member ID:

```html
<input aria-invalid="false" aria-describedby="memberId-helper-text" id="memberId" name="memberId" type="text" aria-required="true" class="MuiInputBase-input MuiOutlinedInput-input MuiInputBase-inputSizeSmall css-1rs2inw" value="">
```

Selector:

```js
"input#memberId[name='memberId']"
```

Group Number:

```html
<input aria-invalid="false" aria-describedby="groupNumber-helper-text" id="groupNumber" name="groupNumber" type="text" aria-required="true" class="MuiInputBase-input MuiOutlinedInput-input MuiInputBase-inputSizeSmall css-1rs2inw" value="">
```

Selector:

```js
"input#groupNumber[name='groupNumber']"
```

Service date MUI field structure:

```html
<div contenteditable="false" tabindex="0" class="MuiPickersSectionList-root MuiPickersInputBase-sectionsContainer css-1uoe3gw"><span data-sectionindex="0" class="MuiPickersSectionList-section css-1pcefeh"><span class="MuiPickersInputBase-sectionBefore css-1wrzzxc"></span><span aria-readonly="false" aria-valuemin="1" aria-valuemax="12" aria-valuetext="Empty" aria-label="Month" aria-disabled="false" tabindex="0" contenteditable="true" role="spinbutton" spellcheck="false" autocapitalize="none" autocorrect="off" inputmode="numeric" class="MuiPickersSectionList-sectionContent MuiPickersInputBase-sectionContent css-ll4rre">MM</span><span class="MuiPickersInputBase-sectionAfter css-1wrzzxc">/</span></span><span data-sectionindex="1" class="MuiPickersSectionList-section css-1pcefeh"><span class="MuiPickersInputBase-sectionBefore css-1wrzzxc"></span><span aria-readonly="false" aria-valuemin="1" aria-valuemax="31" aria-valuetext="Empty" aria-label="Day" aria-disabled="false" tabindex="-1" contenteditable="true" role="spinbutton" spellcheck="false" autocapitalize="none" autocorrect="off" inputmode="numeric" class="MuiPickersSectionList-sectionContent MuiPickersInputBase-sectionContent css-ll4rre">DD</span><span class="MuiPickersInputBase-sectionAfter css-1wrzzxc">/</span></span><span data-sectionindex="2" class="MuiPickersSectionList-section css-1pcefeh"><span class="MuiPickersInputBase-sectionBefore css-1wrzzxc"></span><span aria-readonly="false" aria-valuemin="0" aria-valuemax="9999" aria-valuetext="Empty" aria-label="Year" aria-disabled="false" tabindex="-1" contenteditable="true" role="spinbutton" spellcheck="false" autocapitalize="none" autocorrect="off" inputmode="numeric" class="MuiPickersSectionList-sectionContent MuiPickersInputBase-sectionContent css-ll4rre">YYYY</span><span class="MuiPickersInputBase-sectionAfter css-1wrzzxc"></span></span></div>
```

Member Search:

```html
<button class="MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton-containedPrimary MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorPrimary MuiButton-disableElevation MuiButton-root MuiButton-contained MuiButton-containedPrimary MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorPrimary MuiButton-disableElevation css-lpial5" tabindex="0" type="submit" id="submit-byMember" data-analytics-action="click" data-analytics-form-name="Member" data-analytics-cid="978275" data-analytics-pid="BCBSTX">Search</button>
```

Selector:

```js
"button#submit-byMember[type='submit']"
```

### Search Results

Service Dates cell:

```html
<td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium css-1qzlkip" role="cell"><p class="mb-0">04/16/2026</p><p class="mb-0">04/16/2026</p></td>
```

Search result status:

```html
<span class="badge badge-warning">IN PROCESS</span>
```

Claim Number header:

```html
<th class="MuiTableCell-root MuiTableCell-head MuiTableCell-sizeMedium css-xficba" scope="col" colspan="1" role="columnheader" title="Toggle SortBy" style="cursor: pointer; width: 150px;">Claim Number<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeInherit css-cjnjlw" focusable="false" aria-hidden="true" role="img" viewBox="0 0 320 512"><path d="M137.4 41.4c12.5-12.5 32.8-12.5 45.3 0l128 128c9.2 9.2 11.9 22.9 6.9 34.9s-16.6 19.8-29.6 19.8L32 224c-12.9 0-24.6-7.8-29.6-19.8s-2.2-25.7 6.9-34.9l128-128zm0 429.3l-128-128c-9.2-9.2-11.9-22.9-6.9-34.9s16.6-19.8 29.6-19.8l256 0c12.9 0 24.6 7.8 29.6 19.8s2.2 25.7-6.9 34.9l-128 128c-12.5 12.5-32.8 12.5-45.3 0z"></path></svg></th>
```

Claim Number value:

```html
<td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium css-1qzlkip" role="cell">609950PD2400X00</td>
```

Return to Results:

```html
<a class="MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton-containedTertiary MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorTertiary MuiButton-disableElevation MuiButton-root MuiButton-contained MuiButton-containedTertiary MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorTertiary MuiButton-disableElevation css-1bi16tt" tabindex="0" href="#/element/dashboard?orgId=33674143&amp;payerId=BCBSTX&amp;trxId=0b1b9abe-f881-9b4b-8122-4c9a90917b5f&amp;offset=0">Return to Results</a>
```

Selector:

```js
"a:has-text('Return to Results')"
```

### In-Process Detail

Claim Number label/value:

```html
<p class="MuiTypography-root MuiTypography-body1 css-1xfkw7r">Claim Number </p>
<p class="MuiTypography-root MuiTypography-body1 css-jhrh25">actual claimnumber will be here</p>
```

Claim Status label/value:

```html
<p class="MuiTypography-root MuiTypography-body1 css-1xfkw7r">Claim Status </p>
<span class="my-auto badge badge-secondary">IN-PROCESS</span>
```

Received Date label/value:

```html
<p class="MuiTypography-root MuiTypography-body1 css-1xfkw7r">Received Date </p>
<p class="MuiTypography-root MuiTypography-body1 css-jhrh25">06/01/2026</p>
```

### Paid Detail

Check Number:

```html
<p class="MuiTypography-root MuiTypography-body1 css-1xfkw7r">Check Number </p>
<p class="MuiTypography-root MuiTypography-body1 css-jhrh25">--</p>
```

Check Date:

```html
<p class="MuiTypography-root MuiTypography-body1 css-1xfkw7r">Check Date <p class="MuiTypography-root MuiTypography-body1 css-jhrh25">--</p></p>
<p class="MuiTypography-root MuiTypography-body1 css-jhrh25">--</p>
```

Procedure Code header/value:

```html
<th class="MuiTableCell-root MuiTableCell-head MuiTableCell-sizeMedium css-e0aacx" scope="col" colspan="1" role="columnheader">Procedure Code</th>
<p id="procedureCode-0" class="mb-0">99204</p>
```

Paid header/value:

```html
<th class="MuiTableCell-root MuiTableCell-head MuiTableCell-sizeMedium css-e0aacx" scope="col" colspan="1" role="columnheader">Paid</th>
<td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium css-w1512u" role="cell">$0.00</td>
```

Expand row:

```html
<td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium css-xjrvjf" role="cell"><button class="MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton-containedLink MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorLink MuiButton-disableElevation MuiButton-root MuiButton-contained MuiButton-containedLink MuiButton-sizeLarge MuiButton-containedSizeLarge MuiButton-colorLink MuiButton-disableElevation p-0 css-11cb1j5" tabindex="0" type="button" title="Toggle Row Expanded" style="text-decoration: none;"><svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeInherit css-cjnjlw" focusable="false" aria-hidden="true" role="img" viewBox="0 0 448 512"><path d="M201.4 374.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 306.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z"></path></svg></button></td>
```

Selector:

```js
"button[title='Toggle Row Expanded']"
```

Coinsurance:

```html
<p class="MuiTypography-root MuiTypography-body1 css-1mavczl">Coinsurance</p>
<p class="MuiTypography-root MuiTypography-body1 css-1iptwkv">$0.00</p>
```

Copay:

```html
<p class="MuiTypography-root MuiTypography-body1 css-1mavczl">Copay</p>
<p class="MuiTypography-root MuiTypography-body1 css-1iptwkv">$0.00</p>
```

Deductible:

```html
<p class="MuiTypography-root MuiTypography-body1 css-1mavczl">Deductible</p>
<p class="MuiTypography-root MuiTypography-body1 css-1iptwkv">$180.49</p>
```

### Denied Detail

Reason/Remark Codes:

```html
<p class="MuiTypography-root MuiTypography-body1 css-1mavczl">Reason/Remark Codes</p>
<p class="MuiTypography-root MuiTypography-body1 css-1iptwkv">M22</p>
```

Codes table:

```html
<th class="MuiTableCell-root MuiTableCell-head MuiTableCell-sizeMedium css-1n364p5" scope="col" colspan="1" role="columnheader" style="width: 20%;">Type</th>
<td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium css-1x880e1" role="cell">Remark</td>
<th class="MuiTableCell-root MuiTableCell-head MuiTableCell-sizeMedium css-1n364p5" scope="col" colspan="1" role="columnheader" style="width: 20%;">Code</th>
<td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium css-1x880e1" role="cell">M22</td>
<th class="MuiTableCell-root MuiTableCell-head MuiTableCell-sizeMedium css-1n364p5" scope="col" colspan="1" role="columnheader" style="width: 60%;">Description</th>
<td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium css-1x880e1" role="cell">Services provided are covered up to the allowed amount.  Since that amount has been paid, no additional payment can be made.  Amount is provider write<button class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeLarge MuiButton-textSizeLarge MuiButton-colorPrimary MuiButton-disableElevation MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeLarge MuiButton-textSizeLarge MuiButton-colorPrimary MuiButton-disableElevation css-5mcw5k" tabindex="0" type="button">Show more...</button></td>
```

Show more:

```html
<button class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeLarge MuiButton-textSizeLarge MuiButton-colorPrimary MuiButton-disableElevation MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeLarge MuiButton-textSizeLarge MuiButton-colorPrimary MuiButton-disableElevation css-5mcw5k" tabindex="0" type="button">Show more...</button>
```

Selector:

```js
"button:has-text('Show more')"
```
