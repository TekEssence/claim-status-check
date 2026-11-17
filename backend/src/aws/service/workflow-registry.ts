import type { WorkflowId } from "../../workflows/types";
import { servicePortals, type PortalAdapter, type PreparedServiceInput } from "./portal-dispatch";
import { generateEligibilityServiceInput, validateEligibilityServiceInput } from "./eligibility-input";
import { loadEligibilityServiceSnapshot } from "./eligibility-snapshot";
import { SERVICE_WORKFLOW_IDS, type ServiceWorkflowId } from "./service-contract";
import { ELIGIBILITY_SERVICE_PORTALS } from "./eligibility-portals";

export { SERVICE_WORKFLOW_IDS } from "./service-contract";
export type { ServiceWorkflowId } from "./service-contract";

export type ServiceWorkflowDefinition = {
  id: ServiceWorkflowId;
  runnerWorkflowId: WorkflowId;
  resultLabel: string;
  portals: Record<string, PortalAdapter>;
  unavailableReason?: string;
};

const eligibilityPortals: Record<string, PortalAdapter> = Object.fromEntries(ELIGIBILITY_SERVICE_PORTALS.map(portal => [portal, {
    prepare: async (body: unknown): Promise<PreparedServiceInput> => {
      const input = validateEligibilityServiceInput(body, portal);
      const generated = await generateEligibilityServiceInput(input, portal);
      return {
        claimCount: input.claims.length,
        files: [
          { field: "inputFile", filename: "eligibility.xlsx", buffer: generated.inputWorkbook },
          { field: "credentialFile", filename: "eligibility-login.xlsx", buffer: generated.credentialWorkbook },
        ],
        claimRowsJson: generated.claimRowsJson,
        formFields: { integrationMode: "service", projectId: input.projectId },
        claimFileName: "eligibility.xlsx",
        loginFileName: "eligibility-login.xlsx",
        accountLabel: generated.accountLabel,
      };
    },
    loadSnapshot: loadEligibilityServiceSnapshot,
  }]));

export const serviceWorkflowRegistry: Record<ServiceWorkflowId, ServiceWorkflowDefinition> = {
  [SERVICE_WORKFLOW_IDS.CLAIM_STATUS]: {
    id: SERVICE_WORKFLOW_IDS.CLAIM_STATUS,
    runnerWorkflowId: "claim-status",
    resultLabel: "Claim Status",
    portals: servicePortals,
  },
  [SERVICE_WORKFLOW_IDS.ELIGIBILITY]: {
    id: SERVICE_WORKFLOW_IDS.ELIGIBILITY,
    runnerWorkflowId: "eligibility-verification",
    resultLabel: "Eligibility",
    portals: eligibilityPortals,
  },
  [SERVICE_WORKFLOW_IDS.EOB_DOWNLOAD]: {
    id: SERVICE_WORKFLOW_IDS.EOB_DOWNLOAD,
    runnerWorkflowId: "payment-eob-download",
    resultLabel: "EOB Download",
    portals: {},
    unavailableReason: "EOB Download service input is not supported: existing runners require a date range or reference/control-log batch, not claim rows.",
  },
};

export function getServiceWorkflow(value: unknown): ServiceWorkflowDefinition | null {
  if (typeof value !== "string" || !Object.hasOwn(serviceWorkflowRegistry, value)) return null;
  return serviceWorkflowRegistry[value as ServiceWorkflowId];
}

export function getServiceWorkflowForJob(workflowId: string): ServiceWorkflowDefinition | null {
  return Object.values(serviceWorkflowRegistry).find((item) => item.runnerWorkflowId === workflowId) ?? null;
}

export function supportedServiceWorkflowIds(): ServiceWorkflowId[] {
  return Object.values(serviceWorkflowRegistry).filter((item) => !item.unavailableReason).map((item) => item.id);
}

export class ServiceWorkflowDispatchError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

export function resolveServiceWorkflowRoute(workflowValue: unknown, portalValue: unknown) {
  const workflow = getServiceWorkflow(workflowValue);
  if (!workflow) throw new ServiceWorkflowDispatchError(400,
    `Unsupported workflow ${JSON.stringify(workflowValue)}. Supported: ${supportedServiceWorkflowIds().join(", ")}.`);
  if (workflow.unavailableReason) throw new ServiceWorkflowDispatchError(422, workflow.unavailableReason);
  const portalId = typeof portalValue === "string" ? portalValue : "";
  const adapter = Object.hasOwn(workflow.portals, portalId) ? workflow.portals[portalId] : undefined;
  if (!adapter) throw new ServiceWorkflowDispatchError(422,
    `Portal ${JSON.stringify(portalValue)} is not supported for ${workflow.id}. Supported: ${Object.keys(workflow.portals).join(", ")}.`);
  return { workflow, portalId, adapter };
}

export async function loadIntegratedServiceSnapshot(
  job: Parameters<PortalAdapter["loadSnapshot"]>[0] & { workflowId: string; portalId: string },
  options: { requireStatusColumns?: boolean } = {},
) {
  const workflow = getServiceWorkflowForJob(job.workflowId);
  const portal = workflow && Object.hasOwn(workflow.portals, job.portalId) ? workflow.portals[job.portalId] : undefined;
  if (!portal) throw new Error("Integrated job has an unsupported workflow or portal.");
  return portal.loadSnapshot(job, options);
}
