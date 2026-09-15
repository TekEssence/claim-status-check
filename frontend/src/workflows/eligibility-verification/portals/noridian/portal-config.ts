export const noridianEligibilityFrontendPortalConfig = {
  id: "noridian",
  name: "Noridian",
  description: "MedRevenu Medicare eligibility verification through Noridian.",
  supportedPayers: ["Medicare"],
  projects: ["medrevenue"] as const,
} as const;
