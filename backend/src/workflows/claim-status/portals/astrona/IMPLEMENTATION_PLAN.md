# Astrona Claim Status

Astrona is an independent claim-status portal. Login rows use `Group`, `Payer`,
`URL`, `Username`, and `Password`; input rows use `Group`, `Responsible Payer`, `Member ID`,
and/or `Member Name`. Rows are batched by the exact normalized Group + Payer
credential mapping.

Mixed Responsible Payer rows are grouped in first-seen payer order. All rows for
the first payer are completed together, then the portal is signed out and its
cookies/local session are cleared before the next payer credentials are used.

After login the Responsible Payer selects the provider portal/IPA (numeric Excel
prefixes such as `1 -` are ignored). The Group remains part of credential routing.
The scraper opens Claims,
searches by member, opens every displayed claim number, and extracts claim
number and every aligned service row. Each service becomes a separate output row
with `From`, `To`, `CPT`, `Modifier`, `Diag Code`, `Qty`, `Billed`, `Co-Pay`,
`Co-Insure`, `Deductible`, `Adjustment`, `Net`, and `Memo Line 1`.

Final status is `Denied` when parsed net amount is exactly zero and `Paid` for
any nonzero amount. Missing/unparseable net amount returns `Unknown`.

Because result/detail HTML was not yet supplied, result and detail extraction is
isolated in `portal.ts` and uses semantic labels plus table headers. Replace or
extend only those Astrona selectors when exact production markup is available.
