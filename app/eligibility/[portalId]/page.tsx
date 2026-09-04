import { EligibilityPage } from "@/frontend/src/workflows/eligibility-verification/EligibilityPage";
import { eligibilityPortals } from "@/frontend/src/workflows/eligibility-verification/registry";

// Static export needs every dynamic route to be generated at build time.
export const dynamicParams = false;

export function generateStaticParams() {
  return eligibilityPortals.map((portal) => ({ portalId: portal.id }));
}

export default function EligibilityPortalPage() {
  return <EligibilityPage />;
}
