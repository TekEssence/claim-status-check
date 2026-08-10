import { getSessionFromCookies } from "@/lib/auth/session";
import { isScrapeJobDbConnectionError, listScrapeJobsForUser } from "@/lib/scrape-jobs/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return Response.json({ jobs: [] }, { status: 401 });
    }

    const url = new URL(req.url);
    const rawLimit = Number(url.searchParams.get("limit") || 25);
    const jobs = await listScrapeJobsForUser(session.userId, Number.isFinite(rawLimit) ? rawLimit : 25);
    return Response.json({
      jobs: jobs.map((job) => ({
        ...job,
        artifactCount: job.artifacts.length,
      })),
    });
  } catch (error) {
    console.error("List scrape jobs failed", error);
    if (isScrapeJobDbConnectionError(error)) {
      return Response.json({ error: "Scrape job database connection timed out. Check DATABASE_URL and restart the dev server." }, { status: 503 });
    }

    return Response.json({ error: "Unable to list scrape jobs." }, { status: 500 });
  }
}
