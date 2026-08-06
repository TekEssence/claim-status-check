# Availity Network Layer

Experimental, isolated network layer for Availity claim-status requests.

This module is intentionally not wired into the existing Playwright UI workflows. The current automation continues to log in, select payers/providers, search, extract, and write output exactly as before.

## Intended Flow

```text
Existing Playwright login/MFA
→ authenticated BrowserContext
→ AvailityClaimSearchService
→ POST summarySearch
→ GET summarySearch result
→ POST detailSearch
→ GET detailSearch result
→ normalized rows/details
```

## Safety Constraints

- Do not hardcode cookies, bearer tokens, passwords, OTPs, XSRF values, or PHI.
- Use the authenticated Playwright `BrowserContext` created by the normal login flow.
- Treat `/internal/v1/` endpoints as internal and potentially unsupported.
- Keep existing UI search as fallback when this layer is eventually integrated.
- Do not automatically fallback on authentication or authorization failures.

## Basic Usage After Login

```ts
const service = new AvailityClaimSearchService({ context: session.context });

const result = await service.searchSummaryThenDetail({
  summary: {
    payerId: "HEALTHNET",
    fromDate: "2026-06-02",
    toDate: "2026-06-02",
    providerNpi: "1518153733",
    submitterId: "203499871",
    requestedStatus: "ALL",
  },
});
```

The values above are examples only. Production code should pass values derived from the existing payer/provider/project mappings and the input claim row.

## Current Assumptions To Validate

- Summary search accepts `requestType: "SERVICE_DATE"`.
- Summary POST returns `202` and a search id in `x-global-transaction-id` or `location`.
- Summary GET accepts `id`, `limit`, and `offset`.
- Detail search accepts `requestType: "CLAIM_NUMBER"`.
- Detail POST body should include the summary `parentTransactionId`, payer id, claim number, claim index, and provider NPI.
- Detail GET accepts `id`.

Before integrating this layer into real workflows, validate the detail POST payload against DevTools Network for multiple payers and paid/denied claims.

## Excel-Based Test Runner

The isolated test runner reads a login workbook and a claim workbook, logs into Availity with the existing Playwright login/MFA code, runs summary/detail network calls, and writes a small output workbook.

It does not modify or call the current production Availity workflow.

Claim workbook columns for this test:

```text
Portal Payer Name
Payer ID
DOS
Provider NPI
Submitter ID
Requested Status
Claim Number
Billed Amount
Member ID
Patient Name
Account Number
Customer ID
Client ID
```

`Portal Payer Name` is the visible payer option selected in the Availity UI, for example `Health Net`. `Payer ID` is the network payload value, for example `HEALTHNET`.
`Customer ID` and `Client ID` are optional override columns. The runner attempts to capture `Client ID` from authenticated browser requests and derive `Customer ID` from the provider directory using `Provider NPI`.
`Claim Number` is optional. If it is absent, the runner filters summary rows by any available matching columns: `Billed Amount`, `Member ID`, `Patient Name`, and `Account Number`. If multiple rows still match, it extracts details for all matched rows and writes them one below the other in the same output cells.

Run from the repo root with PowerShell:

```powershell
$env:AVAILITY_NETWORK_LOGIN_EXCEL="C:\path\to\login.xlsx"
$env:AVAILITY_NETWORK_CLAIM_EXCEL="C:\path\to\network-test-claim.xlsx"
npx tsx backend/src/workflows/claim-status/network-layer/availity/excel-network-test.ts
```

Optional output path:

```powershell
$env:AVAILITY_NETWORK_OUTPUT_EXCEL="C:\path\to\availity-network-output.xlsx"
```

The output workbook contains one row per test input with claim-level fields and a multiline CPT summary.
