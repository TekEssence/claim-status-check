export const uhcEligibilityFrontendPortalConfig = {
  id: "uhc",
  name: "UHC",
  description: "Eligibility verification through the UHC portal.",
  supportedPayers: [
    "UHC/Wellmed",
    "AARP Medicare Advantage Wellmed",
    "United Healthcare Dual Complete",
    "United Health Care",
    "UHC Medicare Advantage",
  ],
} as const;
