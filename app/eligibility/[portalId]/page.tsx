import { EligibilityPage } from "@/frontend/src/workflows/eligibility-verification/EligibilityPage";
import { eligibilityPortals } from "@/frontend/src/workflows/eligibility-verification/registry";

// Allow newly registered eligibility portals to resolve immediately in the
// running development/stand server. generateStaticParams still emits every
// registered portal (including Noridian) for static deployments.
export const dynamicParams = true;

export function generateStaticParams() {
  return eligibilityPortals.map((portal) => ({ portalId: portal.id }));
}

export default function EligibilityPortalPage() {
  return <EligibilityPage />;
}
