export const triZettoEligibilityFrontendPortalConfig = {
  id: "trizetto",
  name: "TriZetto",
  description: "MedRevenu eligibility verification using Primary Insurance Name to select the TriZetto payer.",
  supportedPayers: ["Humana", "Exact payer names from the TriZetto directory"],
  projects: ["medrevenue"] as const,
} as const;
