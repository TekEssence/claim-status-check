import { getSessionFromCookies } from "@/lib/auth/session";
import { isAuthDbConnectionError } from "@/lib/auth/db";
import { getActiveAutomationJobForUser, updateAutomationJob } from "@/lib/automation-jobs/db";
import { getScrapeJob } from "@/backend/src/jobs/job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSessionFromCookies();
    if (!session) return Response.json({ job: null }, { status: 401 });

    const job = await getActiveAutomationJobForUser(session.userId);
    if (!job) return Response.json({ job: null });

    const runtimeJob = getScrapeJob(job.jobId);
    if (job.status === "waiting_resume" || !runtimeJob) {
      await updateAutomationJob({ jobId: job.jobId, status: "failed" }).catch(() => {});
      return Response.json({ job: null });
    }

    return Response.json({ job });
  } catch (error) {
    if (isAuthDbConnectionError(error)) {
      return Response.json(
        { error: "Authentication database is temporarily unavailable. Please retry." },
        { status: 503 },
      );
    }
    throw error;
  }
}
