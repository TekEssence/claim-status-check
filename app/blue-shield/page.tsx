import { ClaimStatusPage } from "@/frontend/src/workflows/claim-status/ClaimStatusPage";
import { requirePageAuth } from "@/lib/auth/require-page-auth";

export default async function BlueShieldPage() {
  await requirePageAuth();
  return <ClaimStatusPage forcedPortalId="blue-shield" />;
}
