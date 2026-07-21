import { ClaimStatusPage } from "@/frontend/src/workflows/claim-status/ClaimStatusPage";
import { requirePageAuth } from "@/lib/auth/require-page-auth";

export default async function OptumProPage() {
  await requirePageAuth();
  return <ClaimStatusPage forcedPortalId="optum-pro" />;
}
