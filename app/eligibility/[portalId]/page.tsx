import { EligibilityPage } from "@/frontend/src/workflows/eligibility-verification/EligibilityPage";

export function generateStaticParams() {
  return [
    { portalId: "availity" },
    { portalId: "uhc" },
    { portalId: "waystar" },
  ];
}

export default EligibilityPage;
