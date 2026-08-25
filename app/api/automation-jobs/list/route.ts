import { getSessionFromCookies } from "@/lib/auth/session";
import { isAuthDbConnectionError } from "@/lib/auth/db";
import { listAutomationJobsForUser } from "@/lib/automation-jobs/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await getSessionFromCookies();
    if (!session) return Response.json({ jobs: [] }, { status: 401 });

    const url = new URL(req.url);
    const rawLimit = Number(url.searchParams.get("limit") || 25);
    const jobs = await listAutomationJobsForUser(session.userId, Number.isFinite(rawLimit) ? rawLimit : 25);

    return Response.json({
      jobs: jobs.map((job) => ({
        jobId: job.jobId,
        workflowId: job.workflowId,
        portalId: job.portalId,
        payerId: job.payerId,
        status: job.status,
        currentCompleted: job.currentCompleted,
        totalItems: job.totalItems,
        primaryInputFileName: job.primaryInputFileName,
        credentialFileName: job.credentialFileName,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        artifactCount: job.artifacts.length,
      })),
    });
  } catch (error) {
    console.error("List automation jobs failed", error);
    if (isAuthDbConnectionError(error)) {
      return Response.json(
        { error: "Automation job database connection timed out. Check DATABASE_URL and restart the dev server." },
        { status: 503 },
      );
    }
    return Response.json({ error: "Unable to list automation jobs." }, { status: 500 });
  }
}
