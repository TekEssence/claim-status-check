# Regal Frontend Implementation Plan

## Current phase
- Add Regal as a selectable portal.
- Submit an optional login Excel to the shared scrape job API.
- Show live logs, progress, screenshots, and status from SSE.
- Download Regal HTML and screenshot diagnostics as a zip after the password step.

## Current backend behavior surfaced here
- Shows staged Regal logs from login, dashboard confirmation, REA launch, and MFA.
- Accepts a claim Excel for the first claims search phase.
- Claim Excel format: column A member name, column B DOS.
- Downloads `regal-latest.log` for each run.
- Downloads `regal-diagnostics.zip` with screenshots and HTML.

## Next phase
- Continue from the first claim detail page opened from the claims result table.
- Add claim input/output workbook handling after the VPN/app workflow is known.
