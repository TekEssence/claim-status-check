import { WorkflowDashboardPage } from "@/frontend/src/workflows/WorkflowDashboardPage";
import { requirePageAuth } from "@/lib/auth/require-page-auth";

export default async function PortalPage() {
  await requirePageAuth();
  return <WorkflowDashboardPage />;
}
