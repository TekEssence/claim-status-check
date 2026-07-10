# **Eligibility Verification Architecture Report**

## **1. Purpose Of This Report**

This report explains how to add **Eligibility Verification** into the existing claim status project in a clean and scalable way.

The goal is to support a completely different workflow without breaking the existing **Claim Status Check** functionality.

Eligibility Verification will have different portals, different payer rules, different parsing logic, and different output formats. Some base functionality can still be shared, such as:

- User authentication
- Job creation
- Error handling
- Logging
- Browser setup
- Retry logic
- Screenshots
- File downloads
- Job progress tracking
- API streaming events

The architecture should allow many people to work in parallel without causing large merge conflicts.

---

# **2. Current Project Architecture**

The current project is mainly built around **Claim Status Check**.

Current flow:

```txt
Frontend
  -> Next.js API route
  -> Job store
  -> Scraper registry
  -> Selected portal scraper
  -> Logs / results / downloads
  -> Frontend status and output
```

Important current files:

```txt
backend/src/scrapers/types.ts
backend/src/scrapers/registry.ts
backend/src/scrapers/base.ts
backend/src/routes/scrape-jobs-route.ts
backend/src/jobs/job-store.ts
backend/src/core/
frontend/src/pages/ScraperPage.tsx
db/schema/scrape-jobs.ts
lib/scrape-jobs/db.ts
```

Current claim status portals:

```txt
IEHP
Aerial
Regal
Blue Shield
```

Current backend portal structure:

```txt
backend/src/scrapers/
  iehp/
  aerial/
  regal/
  blue-shield/
```

This works for claim status, but it is not enough for Eligibility Verification because eligibility has another layer: **payers inside portals**.

---

# **3. Why Eligibility Should Not Be Added As Just Another Claim Portal**

Eligibility Verification is not the same thing as Claim Status Check.

Claim Status Check answers questions like:

```txt
Was this claim paid?
Was this claim denied?
What is the claim number?
What is the check number?
What is the final claim status?
```

Eligibility Verification answers different questions:

```txt
Is the member active?
What plan is active?
What benefits are available?
What coverage dates apply?
What payer-specific eligibility response was returned?
What service type is eligible?
```

Because the domain is different, Eligibility should not be mixed directly into the current claim-status scraper registry.

If we add eligibility directly into the current structure, the project can become confusing:

```txt
backend/src/scrapers/iehp/
backend/src/scrapers/blue-shield/
backend/src/scrapers/waystar/
backend/src/scrapers/availity/
```

That would mix:

```txt
claim-status portals
eligibility portals
eligibility payers
claim-specific parsing
eligibility-specific parsing
```

The better approach is to lift the architecture one level up.

---

# **4. Recommended Overall Architecture**

The project should become an **Automation Platform**.

Current model:

```txt
Claim Status App
  -> Portal
```

Recommended model:

```txt
Automation Platform
  -> Workflow
      -> Portal
          -> Payer
```

This gives us a clean hierarchy:

```txt
Workflow = Claim Status or Eligibility Verification
Portal = Website/platform such as Waystar, Availity, IEHP, Blue Shield
Payer = Medicare, ARP, Aetna, Cigna, etc.
```

The important identifiers should be:

```txt
workflowId
portalId
payerId
```

Examples:

```txt
workflowId = claim-status
portalId = iehp
payerId = null
```

```txt
workflowId = eligibility-verification
portalId = waystar
payerId = medicare
```

```txt
workflowId = eligibility-verification
portalId = waystar
payerId = arp
```

```txt
workflowId = eligibility-verification
portalId = availity
payerId = aetna
```

---

# **5. Backend Folder Structure**

Recommended backend structure:

```txt
backend/src/
  core/
    browser.ts
    errors.ts
    logger.ts
    retry.ts
    storage.ts
    screenshots.ts
    downloads.ts
    environment.ts

  jobs/
    job-store.ts
    types.ts

  workflows/
    types.ts
    registry.ts

    claim-status/
      types.ts
      registry.ts
      portals/
        iehp/
        aerial/
        regal/
        blue-shield/

    eligibility-verification/
      types.ts
      registry.ts
      portals/
        waystar/
          config.ts
          scraper.ts
          auth.ts
          selectors.ts
          input.ts
          payer-registry.ts
          payers/
            medicare/
              config.ts
              parser.ts
              flow.ts
              output.ts
              tests/
            arp/
              config.ts
              parser.ts
              flow.ts
              output.ts
              tests/

        availity/
          config.ts
          scraper.ts
          auth.ts
          selectors.ts
          input.ts
          payer-registry.ts
          payers/
            aetna/
            cigna/
            anthem/
```

This structure keeps the code separated by responsibility.

---

# **6. Workflow Level Responsibility**

The workflow level represents the major product/function.

Examples:

```txt
claim-status
eligibility-verification
```

The Eligibility Verification workflow should own shared eligibility concepts:

- Eligibility input row type
- Normalized eligibility result type
- Eligibility result status
- Common eligibility output shape
- Common eligibility event names
- Common eligibility error categories
- Common eligibility job rules

Example:

```txt
backend/src/workflows/eligibility-verification/types.ts
```

This file can define things like:

```txt
EligibilityInputRow
EligibilityResult
EligibilityCoverageStatus
EligibilityPayerConfig
EligibilityPortalRunner
```

The workflow should not contain Waystar-specific or Medicare-specific selectors.

---

# **7. Portal Level Responsibility**

The portal level represents the website/platform.

Examples:

```txt
Waystar
Availity
Another portal
```

For Eligibility Verification, Waystar is a portal. Inside Waystar, there can be many payers.

Waystar should own:

- Login
- MFA handling
- Session handling
- Common portal navigation
- Common Waystar selectors
- Opening the eligibility page
- Choosing/searching payer
- Common Waystar error handling
- Screenshots and diagnostics around the portal

Example:

```txt
backend/src/workflows/eligibility-verification/portals/waystar/
```

This folder should not contain all Medicare and ARP parsing in one large file. It should only contain shared Waystar mechanics.

---

# **8. Payer Level Responsibility**

The payer level represents payer-specific eligibility behavior inside a portal.

Examples under Waystar:

```txt
Medicare
ARP
Other payers
```

Examples under Availity:

```txt
Aetna
Cigna
Anthem
Other payers
```

Each payer should own:

- Payer name/code used in the portal
- Required fields
- Input mapping rules
- Member matching rules
- Subscriber matching rules
- Benefit parsing rules
- Coverage status interpretation
- Payer-specific output columns
- Payer-specific edge cases
- Payer-specific tests

Example:

```txt
backend/src/workflows/eligibility-verification/portals/waystar/payers/medicare/
```

Another example:

```txt
backend/src/workflows/eligibility-verification/portals/waystar/payers/arp/
```

This is useful when two developers are working in parallel.

One developer can work in:

```txt
portals/waystar/payers/medicare/
```

Another developer can work in:

```txt
portals/waystar/payers/arp/
```

They will mostly avoid touching the same files.

---

# **9. Registry Design**

There should be registries at different levels.

Top-level workflow registry:

```txt
backend/src/workflows/registry.ts
```

Example responsibility:

```txt
workflowId -> workflow runner/registry
```

Eligibility portal registry:

```txt
backend/src/workflows/eligibility-verification/registry.ts
```

Example responsibility:

```txt
portalId -> portal runner
```

Waystar payer registry:

```txt
backend/src/workflows/eligibility-verification/portals/waystar/payer-registry.ts
```

Example responsibility:

```txt
payerId -> payer handler
```

Example:

```ts
export const waystarPayerRegistry = {
  medicare: medicarePayer,
  arp: arpPayer,
};
```

These registry files are the only shared files that may commonly cause merge conflicts.

Those conflicts should be small. If one developer adds Medicare and another adds ARP, the final registry should keep both entries.

---

# **10. Shared Contract**

The current project has `PortalScraper`.

For the new architecture, a more neutral contract should be introduced.

Recommended concept:

```ts
export type WorkflowId = "claim-status" | "eligibility-verification";

export type AutomationContext = {
  jobId: string;
  workflowId: WorkflowId;
  portalId: string;
  payerId?: string;
  log: (...) => Promise<void>;
  emit: (...) => Promise<void>;
  isCancelled?: () => boolean;
};

export interface AutomationRunner<TInput = unknown> {
  workflowId: WorkflowId;
  portalId: string;
  name: string;
  validateInput(input: unknown): TInput;
  run(input: TInput, context: AutomationContext): Promise<void>;
}
```

The current `PortalScraper` can remain during migration so existing claim status behavior does not break.

The long-term contract should be workflow-aware.

---

# **11. API Design**

The current API is:

```txt
/api/scrape-jobs
/api/scrape-jobs/current
```

This works for claim status, but the name is not ideal for eligibility.

Recommended future API:

```txt
/api/automation-jobs
/api/automation-jobs/current
/api/automation-jobs/input
```

or:

```txt
/api/jobs
/api/jobs/current
/api/jobs/input
```

The job creation request should include:

```txt
workflowId
portalId
payerId
```

Example request for Waystar Medicare:

```txt
workflowId = eligibility-verification
portalId = waystar
payerId = medicare
```

Example request for IEHP claim status:

```txt
workflowId = claim-status
portalId = iehp
payerId = null
```

To avoid breaking the existing app, the old `/api/scrape-jobs` route can remain while the new generic API is introduced.

---

# **12. Frontend Architecture**

The current frontend has a large file:

```txt
frontend/src/pages/ScraperPage.tsx
```

This file already contains many portal-specific branches. Eligibility should not be added into that same file as more conditions.

Recommended frontend structure:

```txt
frontend/src/
  app-shell/
    AuthenticatedShell.tsx
    DashboardHome.tsx
    WorkflowSelector.tsx

  workflows/
    claim-status/
      ClaimStatusPage.tsx
      registry.ts
      portals/
        iehp/
        aerial/
        regal/
        blue-shield/

    eligibility-verification/
      EligibilityPage.tsx
      registry.ts
      portals/
        waystar/
          WaystarInputForm.tsx
          WaystarResultView.tsx
          portal-config.ts
          payers/
            medicare/
              payer-config.ts
            arp/
              payer-config.ts

        availity/
          portal-config.ts
          payers/
            aetna/
            cigna/
```

Each frontend config should define:

```txt
workflowId
portalId
payerId
name
route
InputForm
ResultView
buildFormData
restorePolicy
```

This lets the frontend render by configuration instead of large hardcoded `if` blocks.

---

# **13. Suggested Routes**

Possible routes:

```txt
/portal
/claim-status
/claim-status/iehp
/claim-status/aerial
/claim-status/regal
/claim-status/blue-shield
/eligibility
/eligibility/waystar
/eligibility/waystar/medicare
/eligibility/waystar/arp
/eligibility/availity
/eligibility/availity/aetna
```

The exact route style can be decided later.

The important part is that the route should reflect:

```txt
workflow -> portal -> payer
```

---

# **14. Eligibility Backend Flow**

Recommended eligibility flow:

```txt
Frontend eligibility form
  -> POST /api/automation-jobs
  -> job store creates job
  -> workflow registry resolves eligibility-verification
  -> portal registry resolves waystar or availity
  -> payer registry resolves medicare, arp, aetna, etc.
  -> portal validates input
  -> browser opens
  -> portal login runs
  -> portal navigates to eligibility screen
  -> payer-specific flow runs
  -> payer-specific parser extracts result
  -> output workbook/report is generated
  -> logs/progress/artifacts are emitted
  -> frontend receives status and downloadable output
```

This flow keeps shared portal behavior and payer-specific behavior separate.

---

# **15. Shared Event Types**

Eligibility can reuse common job events:

```txt
log
progress
error
done
cancelled
input_request
error_screenshot
debug_html
file_download
output_snapshot
```

Eligibility can also introduce eligibility-specific event types:

```txt
eligibility_result
eligibility_row_update
benefit_summary
coverage_status
```

Eligibility should not reuse claim-specific events such as `claim_update`.

---

# **16. What Should Be Shared**

These pieces should be shared across Claim Status and Eligibility Verification:

- Authentication/session system
- Job lifecycle
- Job cancellation
- OTP/input request handling
- SSE event streaming
- DB retry logic
- Persistence helpers
- Core error classes
- Browser launch utilities
- Retry helpers
- Logger
- Screenshots
- Downloads
- Artifact storage
- Common upload/status/log UI components

These are platform-level concerns.

---

# **17. What Should Not Be Shared**

These pieces should remain separate:

- Claim row parsing
- Claim status result formatting
- IEHP workbook post-processing
- Claim-specific output columns
- Eligibility benefit parsing
- Eligibility coverage interpretation
- Eligibility output columns
- Portal-specific selectors
- Payer-specific rules

Sharing these would make the project harder to understand and harder to maintain.

---

# **18. Parallel Development And Merge Safety**

This architecture supports multiple developers working at the same time.

Example:

Developer 1 works on:

```txt
backend/src/workflows/eligibility-verification/portals/waystar/payers/medicare/
frontend/src/workflows/eligibility-verification/portals/waystar/payers/medicare/
```

Developer 2 works on:

```txt
backend/src/workflows/eligibility-verification/portals/waystar/payers/arp/
frontend/src/workflows/eligibility-verification/portals/waystar/payers/arp/
```

Developer 3 works on:

```txt
backend/src/workflows/eligibility-verification/portals/availity/payers/aetna/
frontend/src/workflows/eligibility-verification/portals/availity/payers/aetna/
```

This avoids large conflicts in one giant file.

The only likely conflicts are registry files:

```txt
backend/src/workflows/eligibility-verification/registry.ts
backend/src/workflows/eligibility-verification/portals/waystar/payer-registry.ts
frontend/src/workflows/eligibility-verification/registry.ts
```

These conflicts are usually simple because the final solution is to keep all entries.

---

# **19. Does The Overall Architecture Change?**

Yes, the architecture changes, but in a controlled way.

It changes from:

```txt
Claim Status App
  -> Portal
```

to:

```txt
Automation Platform
  -> Workflow
      -> Portal
          -> Payer
```

The base flow remains familiar:

```txt
Frontend
  -> API route
  -> Job store
  -> Registry
  -> Runner
  -> Logs / results / downloads
  -> Frontend
```

The registry becomes smarter:

```txt
Old:
portalId -> scraper

New:
workflowId -> portalId -> payerId -> runner/handler
```

This does not mean the existing claim-status app needs to be thrown away. It means the existing app is lifted into a broader platform architecture.

---

# **20. Database Changes Needed**

The current database is claim-status specific.

Current table names and fields include:

```txt
iehp_scrape_jobs
iehp_scrape_job_logs
iehp_scrape_job_artifacts
claim_file_name
login_file_name
total_rows
```

This works for claim status, but it is not clean for Eligibility Verification.

Eligibility needs more generic fields:

```txt
workflow_id
portal_id
payer_id
primary_input_file_name
credential_file_name
total_items
metadata_json
```

---

# **21. Recommended New Database Tables**

The best long-term solution is to create new generic tables.

Recommended table:

```txt
automation_jobs
```

Recommended columns:

```txt
job_id
user_id
workflow_id
portal_id
payer_id
status
current_completed
total_items
primary_input_file_name
credential_file_name
metadata_json
created_at
updated_at
finished_at
```

Recommended logs table:

```txt
automation_job_logs
```

Recommended columns:

```txt
id
job_id
level
message
event_name
row_index
metadata_json
created_at
```

Recommended artifacts table:

```txt
automation_job_artifacts
```

Recommended columns:

```txt
id
job_id
row_index
artifact_type
filename
mime_type
path_or_key
metadata_json
created_at
```

---

# **22. Meaning Of New Job Columns**

## **job_id**

Unique ID for the automation run.

## **user_id**

The user who started the job.

## **workflow_id**

Identifies the workflow.

Examples:

```txt
claim-status
eligibility-verification
```

## **portal_id**

Identifies the portal/platform.

Examples:

```txt
iehp
blue-shield
waystar
availity
```

## **payer_id**

Identifies the payer inside the portal.

Examples:

```txt
medicare
arp
aetna
cigna
```

This should be nullable because claim status may not need payer-level routing.

## **status**

Tracks the job status.

Examples:

```txt
running
waiting_resume
completed
failed
cancelled
```

## **current_completed**

How many rows/items have been completed.

## **total_items**

Total rows/items/checks for the job.

This is better than `total_rows` because eligibility might process members, subscribers, service checks, or other item types.

## **primary_input_file_name**

The main uploaded workbook/input file.

For claim status, this can be the claims file.

For eligibility, this can be the eligibility input file.

## **credential_file_name**

The uploaded login/credential workbook, if used.

## **metadata_json**

Flexible JSON for extra workflow-specific information.

Examples:

```txt
service type
provider group
checkpoint key
selected payer label
run mode
environment flags
```

## **created_at**

When the job was created.

## **updated_at**

When the job was last updated.

## **finished_at**

When the job finished, failed, or was cancelled.

---

# **23. Example Database Rows**

Example for IEHP claim status:

```txt
workflow_id = claim-status
portal_id = iehp
payer_id = null
primary_input_file_name = claims.xlsx
credential_file_name = login.xlsx
total_items = 100
```

Example for Waystar Medicare eligibility:

```txt
workflow_id = eligibility-verification
portal_id = waystar
payer_id = medicare
primary_input_file_name = eligibility-input.xlsx
credential_file_name = waystar-login.xlsx
total_items = 250
```

Example for Waystar ARP eligibility:

```txt
workflow_id = eligibility-verification
portal_id = waystar
payer_id = arp
primary_input_file_name = arp-members.xlsx
credential_file_name = waystar-login.xlsx
total_items = 75
```

Example for Availity Aetna eligibility:

```txt
workflow_id = eligibility-verification
portal_id = availity
payer_id = aetna
primary_input_file_name = aetna-eligibility.xlsx
credential_file_name = availity-login.xlsx
total_items = 120
```

---

# **24. Minimal Database Change Option**

If we do not want to create new tables immediately, we can add columns to the current `iehp_scrape_jobs` table.

Minimal columns to add:

```txt
workflow_id
payer_id
total_items
primary_input_file_name
credential_file_name
metadata_json
```

But this is not the best long-term option because the table name and older columns are still claim-specific.

The table would still have confusing names like:

```txt
iehp_scrape_jobs
claim_file_name
login_file_name
```

That can become confusing once eligibility jobs are also stored there.

---

# **25. Recommended Database Direction**

Short term:

```txt
No database change is required while planning.
```

Medium term:

```txt
Add generic automation tables before implementing Eligibility Verification fully.
```

Long term:

```txt
Use automation_jobs, automation_job_logs, and automation_job_artifacts as the main job persistence layer.
```

Avoid forcing Eligibility Verification into `claim_file_name` and other claim-specific fields.

---

# **26. Recommended Implementation Phases**

## **Phase 1: Refactor Without Behavior Change**

- Introduce `workflowId`.
- Add generic workflow types.
- Add workflow registry.
- Register existing claim status portals under `claim-status`.
- Keep existing `/api/scrape-jobs` working.
- Avoid breaking the current UI.

## **Phase 2: Split Frontend By Workflow**

- Extract shared authenticated shell.
- Keep claim status behavior the same.
- Move claim-status portal configs into a claim-status registry.
- Add empty Eligibility Verification page/selector.

## **Phase 3: Add Generic Job Database Layer**

- Add `automation_jobs`.
- Add `automation_job_logs`.
- Add `automation_job_artifacts`.
- Add generic DB access helpers.
- Keep old scrape-job persistence during migration if needed.

## **Phase 4: Add Eligibility Workflow Infrastructure**

- Add `backend/src/workflows/eligibility-verification`.
- Add eligibility types.
- Add portal registry.
- Add frontend eligibility workflow structure.

## **Phase 5: Add First Portal**

- Add Waystar portal folder.
- Implement login/session/navigation shell.
- Add Waystar payer registry.
- Add placeholder Medicare and ARP payer folders.

## **Phase 6: Add First Payer**

- Implement Medicare payer flow.
- Add Medicare parser.
- Add Medicare output mapping.
- Add Medicare tests.

## **Phase 7: Add More Payers And Portals**

- Add ARP under Waystar.
- Add more Waystar payers.
- Add Availity portal.
- Add Availity payers.

---

# **27. Final Recommendation**

Eligibility Verification should be added as a separate workflow, not as another claim status portal.

The clean final architecture is:

```txt
Automation Platform
  -> Claim Status
      -> IEHP
      -> Aerial
      -> Regal
      -> Blue Shield

  -> Eligibility Verification
      -> Waystar
          -> Medicare
          -> ARP
          -> Other payers

      -> Availity
          -> Aetna
          -> Cigna
          -> Other payers
```

This gives the project:

- Clean separation
- Easier future expansion
- Better database naming
- Less merge conflict risk
- Independent payer development
- Shared base platform services
- No damage to existing claim-status behavior

The main rule:

```txt
Workflow = what business function we are doing
Portal = which website/platform we are using
Payer = which payer rules/parser/output we need inside that portal
```

This is the safest and cleanest way to integrate Eligibility Verification into the existing project.
