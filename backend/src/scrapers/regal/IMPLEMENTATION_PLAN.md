# Regal Portal Implementation Plan

## Current Scope

This portal is in the login and Regal Express Access launch milestone only.

Implemented now:

- Load credentials from uploaded login Excel when provided.
- Fallback to env using `env_path_regal` when login Excel is not provided.
- Open the Regal login URL.
- Fill username.
- Click `Next`.
- Fill password.
- Click `Verify`.
- Confirm Okta dashboard by checking both `Dashboard` heading and `Sign out` link.
- Find and click the `Regal Express Access (REA)` app card.
- Handle MFA after REA:
  - if the code page appears directly, request OTP from the frontend.
  - if the security method selection page appears, choose Email, click `Send me an email`, click `Enter a verification code instead`, then request OTP from the frontend.
  - if Email is not available and Phone/SMS is available, choose Phone/SMS, request the text-message code, then request OTP from the frontend.
  - if the direct code page has `Verify with something else`, it can switch to the method selection page.
  - wait up to 2 minutes for the user to submit the OTP; if not submitted, stop the job with an error.
  - if the user manually completes MFA in the headed automation browser during local testing, detect that Regal/REA has been reached and continue instead of submitting another OTP.
- Emit screenshot/HTML diagnostics after dashboard confirmation and after REA launch.
- Download a replaced-on-each-run `regal-latest.log` file for local testing.
- After MFA, select the Regal site/group from the header dropdown before opening `View Claims`.
- Read claim-search input from an uploaded Excel file:
  - `Group`
  - `Member Name`
  - `DOS`
- Reorder processing by group so each site is selected once, then all rows for that group are processed together.
- Search every workbook row by member name and DOS inside its selected group.
- Emit frontend progress against the number of claim input rows, not fixed login milestones.
- Set `Show Claims by Time Frame` to `Show All`.
- Extract all claim rows from the result table and log them.
- If the portal returns `No claims on file.`, emit an output row for that input row with `search_status` and `final_status` set to `No claims on file.`, then continue.
- Open every result via the Member Name link.
- Extract claim detail summary:
  - Provider
  - Specialty
  - Claim # split into `claim_number` and `claim_date`
  - Member ID/Name
  - Carrier
- Click `Show Line Detail`.
- If line detail was already enabled by a prior claim, skip the button and read the line detail table directly.
- Extract all line detail columns:
  - SEQNM
  - CPT
  - Mod
  - DOS
  - Qty/Unit
  - Billed
  - Allowed
  - Pay Amount
  - Status
  - Check Number
  - Check Date/Finalized Date
- Extract all adjustment detail columns:
  - Deductible
  - Copay
  - Coinsurance
  - Adjustment
  - Adjustment Reason
  - Final Adj
  - Final Adj Reason
- Emit `regal_output.xlsx`.

Not implemented yet:

- Additional claim-detail fields beyond the summary and line-detail tables above.

## Environment

The loader supports:

```text
.env
.env.local
external env file from env_path_regal / ENV_PATH_REGAL / REGAL_PORTAL_ENV_PATH
```

Expected keys:

```text
REGAL_PORTAL_LOGIN_URL=
REGAL_PORTAL_USERNAME=
REGAL_PORTAL_PASSWORD=
REGAL_TOTP_DATA_VALUE=
REGAL_TOTP_SECRET=
REGAL_TOTP_DIGITS=6
REGAL_TOTP_ALGORITHM=sha1
```

Regal currently uses manual frontend OTP entry for MFA. `REGAL_TOTP_DATA_VALUE` and `REGAL_TOTP_SECRET` are retained for old/local reference only and are not used by the active Regal flow.

Local browser mode defaults to headed. Vercel is forced headless.

Shared local automation flags:

```text
BROWSER_HEADLESS=false
BROWSER_KEEP_OPEN=false
```

Use `BROWSER_KEEP_OPEN=true` during local debugging when the browser should remain open after the job ends.

## Login Selectors

Username page:

```text
input[name='identifier'][autocomplete='username']
input[type='submit'][value='Next']
```

Password page:

```text
input[name='credentials.passcode'][type='password']
input[type='submit'][value='Verify']
```

Okta dashboard confirmation:

```text
h2:has-text('Dashboard')
h2:has-text('My Apps')
a[data-se='topbar--sign-out'][href='/login/signout']
```

The sign out link can be attached but hidden in the Okta dashboard. Dashboard confirmation accepts an attached Sign out link plus a visible Dashboard/My Apps heading.

Regal Express Access card:

```text
a[data-se='app-card'][aria-label='launch app Regal Express Access (REA)']
a[data-se='app-card']:has-text('Regal Express Access')
a:has-text('Regal Express Access')
```

MFA:

```text
a[data-se='switchAuthenticator']
[data-se='okta_email'] a[data-se='button'], a[aria-label*='Select Email' i]
input[type='submit'][value='Send me an email']
button.enter-auth-code-instead-link:has-text('Enter a verification code instead')
[data-se='phone_number'] a[data-se='button'], a[aria-label*='Select Phone' i], a[aria-label*='phone' i]
input[type='submit'][value*='SMS' i], input[type='submit'][value*='text' i], input[type='submit'][value*='code' i], input[type='submit'][value*='Send' i], button:has-text('Send code'), button:has-text('Send me a code'), button:has-text('Receive a code'), a:has-text('Send code')
[data-se='google_otp'] a[data-se='button'], a[aria-label='Select Google Authenticator.']
input[name='credentials.passcode'][type='text']
input[type='submit'][value='Verify']
```

When Regal reaches the OTP input, the backend emits:

```text
type=input_request
inputName=regal_otp
timeoutMs=120000
```

The frontend shows an OTP field and submits it back to the active job through `PATCH /api/scrape-jobs`. The backend waits for this value and submits it into the Okta OTP field.

The OTP label changes according to the selected MFA method:

```text
Regal email OTP
Regal SMS OTP
Regal OTP
```

Claims search:

```text
a:has-text('View Claims'), a[href*='selclaimmember.asp'], a[href*="navigateFromSideMenuTo('selclaimmember.asp'"]
select[id$='_header_ddlSite'], select[name$='$header$ddlSite']
input#iMember[name='iMember']
input#iDOS[name='iDOS']
select#sTimeFrame[name='sTimeFrame'] -> -1 / Show All
input[type='submit'][name='Search'][value='Search']
table:has(thead td:has-text('Claim Number'))
span.InformationMsg:has-text('No claims on file.')
table:has(thead td:has-text('Claim Number')) tbody tr td:first-child a
input[type='submit'][name='LineDetail'][value='Show Line Detail']
input[type='submit'][name='LineDetail'][value='Hide Line Detail']
table:has(td.tdclaim:has-text('SEQNM'))
```

REA can render `View Claims` as a hidden side-menu link with `href="javascript:navigateFromSideMenuTo('selclaimmember.asp', ...)"`.
If the link is attached but hidden, the scraper calls `navigateFromSideMenuTo("selclaimmember.asp", linkId)` directly; if that function is unavailable, it falls back to direct navigation to `selclaimmember.asp`.
If the portal function returns to `home.aspx` without showing `input#iMember`, the scraper also falls back to direct navigation to `selclaimmember.asp`.

Before opening `View Claims`, the scraper selects the group/site dropdown from the REA header:

```text
IPHS  -> INLAND PHYSICIANS HOSPITALIST SERVICES
IPPS  -> INLAND PHYSICIANS PULMONARY SERVICES
IPPCS -> INLAND PHYSICIANS PRIMARY CARE SERVICES
```

The group mappings live in:

```text
backend/src/scrapers/regal/groups.json
```

The uploaded rows may be jumbled by group. The scraper batches them by first-seen group order so it changes the site dropdown once per group, opens `View Claims`, processes all rows for that group, then switches to the next group. Before switching to a later group, the scraper navigates back to REA `home.aspx` because the site dropdown is only reliably available on the home page where `View Claims` is launched.

REA can render the claim search/results area inside:

```text
iframe#ifrm_Main
```

When this iframe exists, Regal claim search controls, result rows, claim detail, and line detail tables must be read from inside the iframe. After clicking `Search`, do not immediately read existing rows. The scraper waits for a completed `selclaimmember.asp` document response with HTTP 200, then waits for either the result table or the `No claims on file.` message. It does not wait for generic `networkidle` after the search response because the portal-specific response and DOM checks are the stronger signal. If the no-claims message appears, the input row is treated as zero results, an output row is written with the exact message, and processing continues to the next Excel row. For result tables, it also captures the previous result table text and refuses to process if the result table text does not change. This avoids reading stale claims that were already present before the submitted search completed.

After rows are extracted, the scraper filters them to the current Excel input row before opening details:

```text
DOS must match the input DOS after date normalization.
Member name must match the input member prefix, for example GUSHUE,JANET S can match a shortened portal row like GUS S.
```

Each matching claim is opened by its extracted `href`, not by reusing a row index after another search. This prevents the scraper from opening details from a stale result table.

On the claim detail page, line detail is controlled inside `iframe#ifrm_Main`. If `Hide Line Detail` is already visible, line detail is already expanded and extraction continues. If `Show Line Detail` is visible, the scraper clicks it once and waits until `Hide Line Detail` is visible before reading line tables.

Regal renders each line as a SEQNM/CPT table, followed by an adjustment table for that same line. The scraper reads tables in document order:

```text
SEQNM/CPT table for line 1
Deductible/Copay/Adjustment table for line 1
SEQNM/CPT table for line 2
Deductible/Copay/Adjustment table for line 2
Totals table
```

Each SEQNM/CPT table is paired with the next adjustment table before the next SEQNM/CPT table. The Totals table is ignored and never emitted as a separate output row.

Claim result links are inside the iframe document:

```text
dclaim.asp?PF=20260616RMG:20260620921148426482&FromForm=selclaimmember
```

The full detail URL is built using the iframe document URL, not the outer page URL:

```text
iframe document URL: https://rea.regalmed.com/production/selclaimmember.asp?...
detail URL:          https://rea.regalmed.com/production/dclaim.asp?PF=...&FromForm=selclaimmember
```

The scraper navigates `iframe#ifrm_Main` to the detail URL when the iframe exists. Logs include the current iframe URL at View Claims and claim detail stages.

Input workbook:

```text
Group
Member Name
DOS (mm/dd/yyyy)
```
\
Member name normalization:

```text
CAN, DIEGO A -> CAN,DIEGO A
CAN,DIEGO A -> CAN,DIEGO A
CAN, DIEGO ALFONSO -> CAN,DIEGO A
```

There must be no space after the comma. If a middle name or initial exists, keep one space before the initial.

DOS normalization:

```text
6/16/26 -> 06/16/2026
6/16/2026 -> 06/16/2026
```

Regal page validation requires a four-digit year. The scraper normalizes DOS before filling `input#iDOS` and verifies the field contains the normalized value before clicking `Search`.

## Output Workbook

The backend emits `regal_output.xlsx`.

If a later claim fails after earlier rows were extracted, the backend still emits a partial `regal_output.xlsx` with the successfully extracted rows before emitting the error.

Output shape is one row per extracted claim line detail. Each row includes:

```text
input_row_number
input_group
input_member_name
input_dos
search_result_index
search_member_name
search_member_hmo_id
search_provider_name
search_claim_number
search_first_date_of_service
search_diagnosis
search_billed
search_pay_amount
search_status
provider
specialty
claim_number
claim_date
member_id_name
carrier
line_seqnm
line_cpt
line_mod
line_dos
line_qty_unit
line_billed
line_allowed
line_pay_amount
line_status
line_check_number
line_check_date_finalized_date
line_deductible
line_copay
line_coinsurance
line_adjustment
line_adjustment_reason
line_final_adj
line_final_adj_reason
```

For no-claim searches, the output still contains one row for the input row. `search_status` and `final_status` are set to:

```text
No claims on file.
```

## Next Step

Run locally with headed browser and `BROWSER_KEEP_OPEN=true`, then inspect the downloaded `regal_output.xlsx` against the portal detail page.
