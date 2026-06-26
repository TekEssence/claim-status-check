# Aerial Implementation Plan

## Current Input Contract

Aerial claim workbook columns are found by header name, not fixed position.

Required claim workbook headers:

```text
Claim No
Subscriber No
Service Date
```

Supported aliases:

```text
Claim No: Claim No, Claim Number
Subscriber No: Subscriber No, Subscriber Number, Member ID
Service Date: Service Date, Date of Service, DOS
```

Subscriber number normalization:

```text
If Subscriber No starts with XEE, remove the XEE prefix before searching Aerial.
Example: XEE123456789 -> 123456789
```

Subscriber/member ID result matching is case-insensitive:

```text
Input Subscriber No: 98071313e
Returned Member ID: 98071313E
Match: yes
```

Fallback for older files without headers:

```text
Claim No: column A
Subscriber No: old column H
Service Date: old column K
```

Output workbook must include these Aerial status fields:

```text
total_paid
final_status
```

`total_paid` is calculated by adding all extracted EOB service-line paid values for the input row.

`final_status` is generated from the claim detail status text:

```text
Paid, when claim detail status is APPROVED:
DOS xx/xx/xxxx: Checked IEHP portal claim received on xx/xx/xx paid on xx/xx/xx paid amount $xx.xx EFT/Check # xxxxxxx. Claim # xxxxxxx.

Denied, for any other claim detail status:
DOS xx/xx/xxxx: Checked IEHP portal claim received on xx/xx/xx denied on xx/xx/xx denial reason xxxx. Claim# xxxxxxx.
```

## Purpose

Aerial is implemented as a portal scraper under the shared scrape-job platform.

Shared platform pieces stay outside this folder:

- API route: `backend/src/routes/scrape-jobs-route.ts`
- Job/SSE store: `backend/src/jobs`
- Registry: `backend/src/scrapers/registry.ts`

Portal-specific Aerial code stays in this folder.

## Runtime Flow

```text
Frontend selects Aerial
  -> POST /api/scrape-jobs with portalId=aerial
  -> registry selects aerialScraper
  -> Aerial scraper loads env
  -> browser logs in
  -> input workbook rows are validated
  -> claim search runs row-by-row
  -> output workbook and .log file are emitted to frontend
```

## Environment

Real credentials must stay outside git.

The loader supports this order:

```text
.env
.env.local
external env file from env_path / ENV_PATH / PORTAL_AERIAL_ENV_PATH / AERIAL_ENV_PATH
```

Optional external env file keys for credentials:

```text
PORTAL_AERIAL_LOGIN_URL=
PORTAL_AERIAL_USERNAME=
PORTAL_AERIAL_PASSWORD=
```

If these three env values are missing, the uploaded Aerial login workbook may provide credentials using columns such as:

```text
URL / Login URL / Aerial URL
User Name / Username
Password
```

For backward compatibility, the uploaded claim workbook may also provide those same credential columns.

Optional keys:

```text
PORTAL_AERIAL_SUCCESS_URL_FRAGMENT=
PORTAL_AERIAL_CLAIMS_URL=
PORTAL_AERIAL_INPUT_XLSX_PATH=
PORTAL_AERIAL_OUTPUT_PATH=
PORTAL_AERIAL_CHECKPOINT_PATH=
EXCEL_WRITE_BATCH_SIZE=10
PORTAL_AERIAL_RETRY_MAX_ATTEMPTS=2
PORTAL_AERIAL_MAX_RESULT_PAGES=25
PORTAL_AERIAL_SNAPSHOT_ROOT_DIR=error-snapshots
PORTAL_AERIAL_BROWSER_CHANNEL=
HEADLESS=false
BROWSER_HEADLESS=false
BROWSER_KEEP_OPEN=false
```

`PORTAL_AERIAL_CLAIMS_URL` is optional. If it is absent, the scraper uses the portal's configured Claims link/path: `claimInfo.asp`.

Browser mode:

- Local default: `HEADLESS=false` / `BROWSER_HEADLESS=false`, so the browser opens visibly for testing.
- Vercel/deployed: forced headless because serverless environments cannot show a browser window.
- Local override: set `HEADLESS=true` or `BROWSER_HEADLESS=true` if you want local runs hidden.
- Local debugging: set `BROWSER_KEEP_OPEN=true` if you want the browser to stay open after the run.

Locally, set the external env path before starting Next:

```powershell
$env:env_path="C:\env\Claim_status\aerial.env"
npm run dev
```

## Input Workbook

The platform supports both:

- frontend upload: `credentialExcel` for login credentials
- frontend upload: `inputExcel` for claim details
- fallback env path: `PORTAL_AERIAL_INPUT_XLSX_PATH`

Required claim columns are listed at the top of this plan under `Current Input Contract`.

The original input workbook is not modified. The scraper returns a new output workbook.

## Output

The job emits downloadable files over SSE:

```text
aerial_output.xlsx
aerial-run.log
```

The server also writes:

```text
data/logs/aerial/<jobId>/aerial-run.log
data/screenshots/aerial/<jobId>/
```

## Portal Logic

Reusable Aerial browser helpers from the original project live in:

```text
legacy/
```

The TypeScript platform adapter lives in:

```text
scraper.ts
claim-status-job.ts
input.ts
workbook.ts
env.ts
browser.ts
log-file.ts
```

The next cleanup step should gradually convert `legacy/*.js` into typed TypeScript modules with tests.
