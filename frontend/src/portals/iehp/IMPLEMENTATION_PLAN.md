# IEHP Frontend Plan

The frontend portal owns only IEHP-specific UI and workbook behavior.

Current behavior:

- User selects `IEHP` from the first screen.
- User uploads the IEHP login Excel.
- User selects a claim workbook with browser file access.
- Backend row updates are applied to the selected workbook.
- Post-processing runs after all rows complete.

Shared frontend pieces stay outside this folder:

- `frontend/src/pages/ScraperPage.tsx`
- `frontend/src/api/scrape-jobs-api.ts`
- `frontend/src/components`
- `frontend/src/types`
