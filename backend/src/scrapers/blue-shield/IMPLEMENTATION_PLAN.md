# Blue Shield Implementation Plan

## Purpose

Blue Shield is implemented as a portal scraper under the shared scrape-job platform.

Shared platform pieces stay outside this folder:

- API route: `backend/src/routes/scrape-jobs-route.ts`
- Job/SSE store: `backend/src/jobs`
- Registry: `backend/src/scrapers/registry.ts`

Portal-specific Blue Shield logic stays in this folder.

## Runtime Flow

```text
Frontend selects Blue Shield
  -> POST /api/scrape-jobs with portalId=blue-shield
  -> registry selects blueShieldScraper
  -> Blue Shield scraper loads env
  -> credential workbook resolves the selected group login details
  -> input workbook rows are validated and grouped by unique member
  -> persistent browser profile logs in with MFA support
  -> claim status search runs member-by-member
  -> checkpoints are saved after each completed member
  -> output workbook and optional error log are emitted to frontend
```

## Environment

Real credentials must stay outside git.

The loader supports this order:

```text
.env
.env.local
external env file from PORTAL_BLUE_SHIELD_ENV_PATH / BLUE_SHIELD_ENV_PATH / env_path / ENV_PATH
```

Credentials are expected from the uploaded Blue Shield login workbook, selected by group. The workbook should include columns such as:

```text
Group / Payer / Portal / Portal Group
URL / Portal Link / Login URL / Blue Shield URL
User Name / Username / PORTAL_BLUE_SHIELD_USERNAME
Password / PORTAL_BLUE_SHIELD_PASSWORD
Claim Status URL / Claim URL / PORTAL_BLUE_SHIELD_CLAIM_STATUS_URL
MFA Mailbox / Mailbox / PORTAL_BLUE_SHIELD_MFA_MAILBOX
```

Optional env keys:

```text
PORTAL_BLUE_SHIELD_ENV_PATH=
BLUE_SHIELD_ENV_PATH=
PORTAL_BLUE_SHIELD_MFA_MAILBOX=
PORTAL_BLUE_SHIELD_USER_DATA_DIR=
PORTAL_BLUE_SHIELD_HEADLESS=false
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=
```

Blue Shield is currently configured for local execution only and requires VPN access.

## Input Workbook

The platform supports:

- frontend upload: `credentialExcel` for login credentials
- frontend upload: `inputExcel` for claim/member details
- form value: `group`, defaulting to `Posada`
- optional form value: `checkpointId`
- optional form value: `resetCheckpoint`

The input workbook is read from the first worksheet. Required values are resolved by header aliases:

```text
Member ID / Member Number / Subscriber ID / Subscriber No / Insurance ID / Policy ID
DOS / Date Of Service / Service Date / Svc Date / From DOS / DOS From
```

Rows missing member ID or DOS are written to the output error sheet instead of being searched.

## Output

The job emits downloadable files over SSE:

```text
BlueShield_Output.xlsx
blue-shield-error.log
```

`blue-shield-error.log` is emitted only when validation, member processing, security detection, or job errors are recorded.

The output workbook contains:

```text
Output
Error
Audit_Log
```

The server also writes:

```text
data/outputs/blue-shield/<jobId>/BlueShield_Output.xlsx
data/logs/blue-shield/<jobId>/blue-shield-error.log
data/checkpoints/blue-shield/
data/browser-profiles/blue-shield/
```

## Portal Logic

Main files:

```text
scraper.ts
claim-status-job.ts
input.ts
browser.ts
login.ts
otp-service.ts
claim-status.ts
claim-extraction.ts
checkpoint-service.ts
detection-monitor.ts
output-writer.ts
storage.ts
types.ts
config.ts
env.ts
```

The next cleanup step should add focused tests for input parsing, checkpoint resume behavior, and output workbook generation.
