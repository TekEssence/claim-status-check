import { getSessionFromCookies } from "@/lib/auth/session";
import { getActiveAutomationJobForUser, updateAutomationJob } from "@/lib/automation-jobs/db";
import { getScrapeJob } from "@/backend/src/jobs/job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionFromCookies();
  if (!session) return Response.json({ job: null }, { status: 401 });

  let job = await getActiveAutomationJobForUser(session.userId);
  if (job?.status === "running" && !getScrapeJob(job.jobId)) {
    await updateAutomationJob({ jobId: job.jobId, status: "failed" }).catch(() => {});
    job = null;
  }
  return Response.json({ job });
}
