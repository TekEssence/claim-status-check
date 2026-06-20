# Aerial Frontend Plan

The frontend portal owns only Aerial-specific UI.

Current behavior:

- User selects `Aerial` from the first screen.
- User uploads the Aerial input workbook.
- Credentials are not uploaded; they are loaded by the backend from env.
- Output workbook and `.log` file are downloaded when the backend emits `file_download` events.

Shared frontend pieces stay outside this folder:

- `frontend/src/pages/ScraperPage.tsx`
- `frontend/src/api/scrape-jobs-api.ts`
- `frontend/src/components`
- `frontend/src/types`
