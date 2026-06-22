# Regal Frontend Implementation Plan

## Current phase
- Add Regal as a selectable portal.
- Submit an optional login Excel to the shared scrape job API.
- Show live logs, progress, screenshots, and status from SSE.
- Download Regal HTML and screenshot diagnostics as a zip after the password step.

## Current backend behavior surfaced here
- Shows staged Regal logs from login, dashboard confirmation, REA launch, and MFA.
- Downloads `regal-latest.log` for each run.
- Downloads `regal-diagnostics.zip` with screenshots and HTML.

## Next phase
- Continue from the page shown after Google Authenticator verification.
- Add claim input/output workbook handling after the VPN/app workflow is known.
