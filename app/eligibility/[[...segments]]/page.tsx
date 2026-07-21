import { EligibilityPage } from "@/frontend/src/workflows/eligibility-verification/EligibilityPage";
import { requirePageAuth } from "@/lib/auth/require-page-auth";

export default async function EligibilityRoutePage() {
  await requirePageAuth();
  return <EligibilityPage />;
}
