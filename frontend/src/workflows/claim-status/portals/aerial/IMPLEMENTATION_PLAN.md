# Aerial Frontend Plan

The frontend portal owns only Aerial-specific UI.

Current behavior:

- User selects `Aerial` from the first screen.
- User selects the `PMG` or `Citrus Valley` Aerial subportal.
- User uploads the Aerial login workbook.
- User uploads the Aerial claim details workbook.
- Credentials can also be loaded by the backend from env.
- Output workbook and `.log` file are downloaded when the backend emits `file_download` events.

Frontend subportal routing is organized as:

```text
subportals/PMG.ts
subportals/CitrusValley.ts
subportals/registry.ts
common/AerialSharedInputFields.tsx
common/types.ts
```

PMG and Citrus Valley define only their display and credential requirements.
The upload and processing UI stays in the shared common component.

Shared frontend pieces stay outside this folder:

- `frontend/src/workflows/claim-status/ClaimStatusPage.tsx`
- `frontend/src/api/scrape-jobs-api.ts`
- `frontend/src/components`
- `frontend/src/types`
