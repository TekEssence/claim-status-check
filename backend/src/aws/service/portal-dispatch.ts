import { generateAvailityServiceInput, validateAvailityServiceInput } from "./availity-input";
import { loadAvailityServiceSnapshot } from "./availity-snapshot";
import { generateIehpServiceInput, maskIehpAccountLabel, validateIehpServiceInput } from "./iehp-input";
import { loadIehpServiceSnapshot } from "./iehp-snapshot";
import { claimStatusServicePortalConfigs, prepareGenericClaimStatusServiceInput, type GenericClaimStatusServicePortalId } from "./generic-claim-status-input";
import { loadGenericClaimStatusSnapshot } from "./generic-claim-status-results";

type ServiceJob = Parameters<typeof loadIehpServiceSnapshot>[0];
type InputFile = { field: string; filename: string; buffer: Buffer };
export type PreparedServiceInput = {
  claimCount: number;
  files: InputFile[];
  claimRowsJson: string;
  formFields: Record<string, string>;
  claimFileName: string;
  loginFileName: string;
  accountLabel: string;
};

export type PortalAdapter = {
  prepare: (body: unknown) => Promise<PreparedServiceInput>;
  loadSnapshot: typeof loadIehpServiceSnapshot;
};

const genericServicePortals = Object.fromEntries(
  (Object.keys(claimStatusServicePortalConfigs) as GenericClaimStatusServicePortalId[]).map((portalId) => [
    portalId,
    {
      prepare: (body: unknown) => prepareGenericClaimStatusServiceInput(portalId, body),
      loadSnapshot: (job: ServiceJob) => loadGenericClaimStatusSnapshot(portalId, job),
    },
  ]),
) as Record<GenericClaimStatusServicePortalId, PortalAdapter>;

export const servicePortals = {
  ...genericServicePortals,
  iehp: {
    prepare: async (body: unknown) => {
      const input = validateIehpServiceInput(body);
      const generated = await generateIehpServiceInput(input);
      return {
        claimCount: input.claims.length,
        files: [
          { field: "claimExcel", filename: "claims.xlsx", buffer: generated.claimWorkbook },
          { field: "loginExcel", filename: "login.xlsx", buffer: generated.loginWorkbook },
        ],
        claimRowsJson: generated.claimRowsJson,
        formFields: { integrationMode: "service", claimFileName: "claims.xlsx", loginFileName: "login.xlsx", startIndex: "0" },
        claimFileName: "claims.xlsx",
        loginFileName: "login.xlsx",
        accountLabel: maskIehpAccountLabel(input.credentials.username),
      };
    },
    loadSnapshot: loadIehpServiceSnapshot,
  },
  availity: {
    prepare: async (body: unknown) => {
      const input = validateAvailityServiceInput(body);
      const generated = await generateAvailityServiceInput(input);
      return {
        claimCount: input.claims.length,
        files: [
          { field: "inputExcel", filename: "availity_claims.xlsx", buffer: generated.claimWorkbook },
          { field: "credentialExcel", filename: "availity_credentials.xlsx", buffer: generated.credentialWorkbook },
          ...(generated.selectionRulesWorkbook ? [{ field: "selectionRulesFile", filename: "availity-selection-rules.xlsx", buffer: generated.selectionRulesWorkbook }] : []),
        ],
        claimRowsJson: generated.claimRowsJson,
        formFields: { integrationMode: "service", projectId: input.projectId },
        claimFileName: "availity_claims.xlsx",
        loginFileName: "availity_credentials.xlsx",
        accountLabel: generated.accountLabel,
      };
    },
    loadSnapshot: loadAvailityServiceSnapshot,
  },
} satisfies Record<string, PortalAdapter>;

export type ServicePortalId = keyof typeof servicePortals;

export function getServicePortal(portal: unknown): { id: ServicePortalId; adapter: PortalAdapter } | null {
  if (typeof portal !== "string" || !Object.hasOwn(servicePortals, portal)) return null;
  const id = portal as ServicePortalId;
  return { id, adapter: servicePortals[id] };
}

export async function loadServiceSnapshot(job: ServiceJob & { portalId: string }, options: { requireStatusColumns?: boolean } = {}) {
  const portal = getServicePortal(job.portalId);
  if (!portal) throw new Error("Integrated job has an unsupported portal.");
  return portal.adapter.loadSnapshot(job, options);
}
