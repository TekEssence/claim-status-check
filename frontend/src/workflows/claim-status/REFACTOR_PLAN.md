# Claim Status Page Refactor

Goal: keep `ClaimStatusPage.tsx` as a coordinator and make future portals use shared UI and lifecycle behavior.

## Completed

- Login and password UI: `components/LoginView.tsx`
- Active-run, operations, and output UI: `components/WorkflowPanels.tsx`
- Portal display configuration: `portal-meta.ts`
- Shared types and status rules: `shared/model.ts`
- Download and artifact handling: `shared/artifacts.ts`
- Workbook file handling: `shared/workbook-files.ts`

## Next extraction order

1. `hooks/useAuthentication.ts`
   - Authentication initialization, login/logout, password reset, and managed-user operations.
2. `hooks/useJobLifecycle.ts`
   - Job listing, selection, cancellation, force-stop, recovery, and subscriptions.
3. `hooks/usePortalWorkflow.ts`
   - Shared processing state, progress, logs, screenshots, file readiness, and completion state.
4. `components/PortalDashboard.tsx`
   - Portal search, filtering, sorting, cards, and portal selection.
5. `components/PortalWorkspace.tsx`
   - Selected-portal header, workflow steps, shared processing shell, and reset controls.
6. `components/PortalFormRenderer.tsx`
   - Registry-driven mapping from portal ID to its input form.
7. `components/PortalResultRenderer.tsx`
   - Registry-driven mapping from portal ID to its result view.
8. Portal adapters
   - Move each portal's submit and event translation behind one common interface gradually.

## Safety rules

- Do not change backend portal automation.
- Do not alter request payloads, event names, OTP behavior, or workbook output.
- Validate TypeScript and diff integrity after every extraction.
- Move one responsibility at a time so production behavior remains traceable.
