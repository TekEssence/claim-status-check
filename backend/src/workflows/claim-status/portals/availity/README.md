# Availity Claim Status

This folder contains the shared Availity portal automation used by multiple projects. Project differences belong in configuration; portal behavior belongs in shared pages, services, workflows, or payer folders.

## Read Before Changing Code

Before adding or changing Availity behavior:

1. Read this file.
2. Identify whether the requirement is project-specific, payer-specific, or shared portal behavior.
3. Read the existing project configuration and payer registry.
4. Check the shared page/extractor modules before creating a new extractor.
5. Add payer-specific code only when the payer UI or processing flow is genuinely different.

Do not copy the same selector, form-filling, matching, or extraction logic into every project or payer.

## Mental Model

```text
Project input
  -> project configuration
  -> exact Availity organization/provider/payer/state selections
  -> payer workflow routing
  -> shared portal pages and extractors
  -> project output mapping
```

- A **project** defines Excel columns, defaults, mappings, matching rules, and output requirements.
- A **payer workflow** defines which Availity search flow to use.
- A **shared page/extractor** interacts with common Availity UI and reads common results.

## Registered Projects

Project registrations are in `config/projects/`:

- `charm.ts`
- `medrevenu.ts`
- `minimax.ts`
- `index.ts` registers and resolves them.

### Charm Configuration

Charm currently configures:

- Excel aliases for payer, patient, Patient ID, DOB, insured/member ID, service date, amount, provider, NPI, practice/group, and invoice number.
- `Payer to choose in Availity` as the exact portal payer selection.
- `State to choose in Availity` as the portal state; an empty value is skipped.
- Practice/group-to-organization mappings.
- Practice/group-to-provider fallback mappings.
- Provider NPI from input when present.
- Matching by service date and billed amount, with Patient ID then full-name then first/last-name identity checks.
- On HIPAA Standard, identity mismatch is reported but does not block detail extraction after date and amount match.
- Output mappings for Group/Practice, Charges/Claim Amount, Patient ID, and Patient Identity Match.

Charm organization and provider values are maintained in `config/projects/charm.ts`, not in the claim input workbook. The workbook supplies the practice/group key.

## Mapping Types

| Mapping | Purpose | Main location |
|---|---|---|
| Input columns | Converts each project's Excel headers into standard internal fields | `config/projects/*.ts` |
| Organization | Converts practice/group into the exact Availity organization | `config/projects/*.ts` |
| Provider | Converts practice/group into a provider fallback; input NPI may take priority | `config/projects/*.ts` |
| Portal payer | Chooses the exact payer shown in Availity | Project input/config and `project-config.ts` |
| Workflow routing | Routes payer-name variations to the main payer workflow | `payers/registry.js` |
| Output columns | Converts standard results back into project-specific workbook columns | `config/projects/*.ts`, `project-output.ts` |

## Payer Routing

`payers/registry.js` checks both the input payer name and mapped portal payer name.

Examples:

- Regence, Premera, BCBS, BCBSTX, Blue Cross, and Blue Shield route to the Blue Cross Blue Shield workflow.
- Carelon and BHOMD route to Carelon Behavioral Health.
- TriWest and TRICARE route to TriWest-TRICARE.
- VA CCN and VACC route to TriWest-VA CCN.
- Health Net and HealthNet route to Health Net.

Different payer names do not require different extractor folders when their Availity UI and behavior are the same.

## Search-Tab Priority

When supported tabs are available, use this order:

For the Blue Cross family (including Regence, Premera, CareFirst, and Anthem-CT):

1. HIPAA Standard
2. Service Dates
3. Member Search
4. Claim Number

Other payer workflows retain their configured payer-specific tab.

A tab can be skipped when it is unavailable or its required input is missing. Do not silently route to a lower-priority tab because detection looked in the wrong frame; use the shared claim-status frame resolver.

## Where Code Belongs

```text
availity/
|-- config/projects/       Project-only fields, mappings, defaults, and policies
|-- payers/                Payer routing and genuinely payer-specific workflows
|-- pages/                 Shared Availity navigation, forms, results, and details
|-- services/              Shared validation, identity, status, and summary logic
|-- workflows/             Shared claim-processing orchestration
|-- input.ts               Workbook parsing and supported-payer validation
|-- project-config.ts      Project configuration resolution
|-- project-output.ts      Project-specific output transformation
`-- claim-status-job.ts    Job-level orchestration
```

### Put a change in project configuration when

- Excel headers differ by project.
- A project has a default state or selection.
- A practice maps to a different organization/provider.
- Matching or output requirements differ by project.

### Put a change in a payer folder when

- The payer exposes different tabs.
- Its form requires a different sequence or fields.
- Its results/detail UI is genuinely different from shared Availity UI.

### Put a change in shared code when

- The selector or behavior is common across Availity payers.
- Multiple payers use the same table/detail structure.
- Date entry, dropdown selection, state changes, result parsing, or matching can be reused.

## Shared Extractors

- `pages/results.page.js`: common search-results table parsing.
- `pages/claim-detail.page.js`: common claim-level and line-level detail extraction.
- `pages/claim-status-hipaa.page.js`: HIPAA Standard form behavior.
- `pages/claim-status-member.page.js`: Member Search form behavior.
- `pages/provider-identifiers.page.js`: shared Provider NPI and Tax ID validation/filling for plain identifier inputs.
- `workflows/shared-claim-workflow.js`: shared provider attempts, matching, and result processing.
- `services/patient-identity.js`: Patient ID parsing and identity matching.

Reuse these before adding payer-specific extraction code.

When input Provider NPI or Tax ID values are present, fill their stable plain inputs independently of the Provider autocomplete. A missing Provider dropdown option must not prevent identifier-based processing when the active tab exposes those inputs.

## Portal Response Messages

Availity commonly renders payer responses inside `#results [role="alert"]`. Bootstrap and Material UI may use different classes, but the semantic container is shared and message text varies by payer.

The shared response extractor must:

- collect every visible result alert, not only the first;
- preserve error, warning, and informational messages;
- deduplicate exact repeats;
- format messages as readable multiline Excel notes;
- preserve informational messages even when valid claim rows are returned; and
- fall back only to validation/helper text associated with invalid form controls when a message is outside `#results`.

Do not document every payer message string here. Update this section only when the reusable Availity response pattern or code ownership changes.

## Safe Change Checklist

- Confirm the project configuration already exposes the required value.
- Confirm payer aliases route to the correct main workflow.
- Inspect the actual tab/form/result HTML and prefer stable labels, roles, IDs, and `data-testid` attributes.
- Avoid generated Material UI `css-*` classes.
- Type into Availity controls and select a real dropdown option; do not treat typed text as a successful selection.
- Stop the row when a required organization, state, payer, or provider option cannot be selected.
- Preserve other projects' behavior by keeping project exceptions in configuration.
- Run focused syntax/tests for the files changed; deployment is not required for local code verification.

## Historical Document

`IMPLEMENTATION_PLAN_DRAFT.md` is an early implementation plan. It is useful as history, but several statements in it predate HIPAA support, project configuration, current payer routing, and the shared extractor architecture. Use this README as the current starting point.
