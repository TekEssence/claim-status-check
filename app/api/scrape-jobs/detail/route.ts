import { getSessionFromCookies } from "@/lib/auth/session";
import { getScrapeJobById, getScrapeJobByIdForUser, isScrapeJobDbConnectionError } from "@/lib/scrape-jobs/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }

    const url = new URL(req.url);
    const jobId = url.searchParams.get("jobId")?.trim() || "";
    if (!jobId) {
      return Response.json({ error: "Missing scrape jobId." }, { status: 400 });
    }

    const canSeeAnyJob = session.role === "ADMIN" || session.role === "DEVELOPER";
    const job = canSeeAnyJob ? await getScrapeJobById(jobId) : await getScrapeJobByIdForUser(jobId, session.userId);
    if (!job) {
      return Response.json({ error: "Run not found for this user." }, { status: 404 });
    }

    return Response.json({ job });
  } catch (error) {
    console.error("Load scrape job detail failed", error);
    if (isScrapeJobDbConnectionError(error)) {
      return Response.json({ error: "Scrape job database connection timed out. Check DATABASE_URL and restart the dev server." }, { status: 503 });
    }

    return Response.json({ error: "Unable to load scrape job detail." }, { status: 500 });
  }
}
