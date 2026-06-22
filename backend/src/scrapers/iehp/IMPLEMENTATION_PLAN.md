# IEHP Implementation Plan

## Purpose

IEHP is implemented as a portal scraper under the shared scrape-job platform.

Shared platform pieces stay outside this folder:

- API route: `backend/src/routes/scrape-jobs-route.ts`
- Job/SSE store: `backend/src/jobs`
- Registry: `backend/src/scrapers/registry.ts`

Portal-specific IEHP logic stays in this folder.

## Runtime Flow

```text
Frontend selects IEHP
  -> POST /api/scrape-jobs with portalId=iehp
  -> registry selects iehpScraper
  -> IEHP scraper validates form data
  -> browser logs in from uploaded login Excel
  -> claim rows are processed
  -> row_update events update the selected workbook in browser
  -> screenshots/debug HTML are emitted and saved for row failures
```

## Input

IEHP currently uses:

- login Excel upload
- claim workbook selected with the browser File System Access API

The frontend reads the claim workbook and sends claim rows to the backend. The backend sends `row_update` events back as rows finish.

## Output

IEHP updates the selected claim workbook in place from the browser.

Failed-row diagnostics are saved under:

```text
data/screenshots/<jobId>/
```

Browser mode:

- Local default: visible browser for testing.
- Vercel/deployed: forced headless.
- Local override: set `HEADLESS=true` or `BROWSER_HEADLESS=true` to run hidden.
- Local debugging: set `BROWSER_KEEP_OPEN=true` to leave the browser open after the run.

## Portal Logic

Main files:

```text
scraper.ts
claim-status-job.ts
input.ts
browser.ts
auth.ts
claim-status.ts
claim-details.ts
covered-ra.ts
refer-ra.ts
diagnostics.ts
claims/
tests/
```

The next cleanup step should split the large row loop in `claim-status-job.ts` into smaller typed workflow modules.
