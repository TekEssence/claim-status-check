import { UnknownPortalError } from "../core/errors";
import { getClaimStatusRunner } from "./claim-status/registry";
import { getEligibilityRunner } from "./eligibility-verification/registry";
import type { AutomationRunner, WorkflowDefinition, WorkflowId } from "./types";

export const workflowRegistry = {
  "claim-status": {
    id: "claim-status",
    name: "Claim Status",
    getRunner: (portalId) => getClaimStatusRunner(portalId),
  },
  "eligibility-verification": {
    id: "eligibility-verification",
    name: "Eligibility Verification",
    getRunner: getEligibilityRunner,
  },
} satisfies Record<WorkflowId, WorkflowDefinition>;

export function getAutomationRunner(
  workflowId: string,
  portalId: string,
  payerId?: string,
): AutomationRunner {
  const workflow: WorkflowDefinition | undefined =
    workflowRegistry[workflowId as WorkflowId];
  if (!workflow) throw new UnknownPortalError(workflowId);
  return workflow.getRunner(portalId, payerId);
}
