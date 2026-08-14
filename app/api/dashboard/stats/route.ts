import { isAuthDbConnectionError } from "@/lib/auth/db";
import { getSessionFromCookies } from "@/lib/auth/session";
import { getDashboardStatsForUser } from "@/lib/scrape-jobs/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AVAILABLE_PORTALS_COUNT = 4;

export async function GET() {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const stats = await getDashboardStatsForUser(session.userId, AVAILABLE_PORTALS_COUNT);
    return Response.json({ stats });
  } catch (error) {
    console.error("Load dashboard stats failed", error);
    if (isAuthDbConnectionError(error)) {
      return Response.json({ error: "Database connection timed out. Check DATABASE_URL and restart the dev server." }, { status: 503 });
    }
    return Response.json({ error: "Unable to load dashboard stats." }, { status: 500 });
  }
}
