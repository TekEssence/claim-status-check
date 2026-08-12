import { EligibilityPage } from "@/frontend/src/workflows/eligibility-verification/EligibilityPage";
import { eligibilityPortals } from "@/frontend/src/workflows/eligibility-verification/registry";

export const dynamicParams = false;

export function generateStaticParams() {
  return eligibilityPortals.map((portal) => ({ portalId: portal.id }));
}

export default function EligibilityPortalPage() {
  return <EligibilityPage />;
}
