/** Portals with a verified service input and coverage result. */
export const ELIGIBILITY_SERVICE_PORTALS = ["availity", "healthnet", "iehp", "medical", "trizetto", "waystar", "uhc"] as const;
export type EligibilityServicePortal = typeof ELIGIBILITY_SERVICE_PORTALS[number];

export function isEligibilityServicePortal(portal: string): portal is EligibilityServicePortal {
  return (ELIGIBILITY_SERVICE_PORTALS as readonly string[]).includes(portal);
}

export function eligibilityServiceProject(portal: EligibilityServicePortal): "minimax" | "medrevenue" {
  return portal === "uhc" ? "minimax" : "medrevenue";
}

export function eligibilityServiceOutputFilenames(portal: string): string[] {
  if (!isEligibilityServicePortal(portal)) return [];
  return [`${eligibilityServiceProject(portal)}-${portal}-eligibility-output.xlsx`,
    ...(portal === "uhc" ? ["uhc-wellmed-eligibility-results.xlsx", "uhc-wellmed-eligibility-partial-results.xlsx"] : []),
    ...(portal === "waystar" ? ["waystar-eligibility-output.xlsx"] : []),
    `${portal}-eligibility-partial-output.xlsx`];
}
