import fs from "node:fs";
import path from "node:path";
import { getSessionFromCookies } from "@/lib/auth/session";
import { getScrapeJobByIdForUser, isScrapeJobDbConnectionError } from "@/lib/scrape-jobs/db";

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

    const job = await getScrapeJobByIdForUser(jobId, session.userId);
    if (!job) {
      return Response.json({ error: "Run not found for this user." }, { status: 404 });
    }

    const artifact = [...job.artifacts]
      .reverse()
      .find((candidate) =>
        (candidate.artifactType === "file_download" || candidate.artifactType === "output_snapshot") &&
        candidate.pathOrKey &&
        fs.existsSync(candidate.pathOrKey),
      );
    if (!artifact) {
      return Response.json({ error: "No downloadable output is available for this run yet." }, { status: 404 });
    }

    const filename = artifact.filename || path.basename(artifact.pathOrKey) || "claim-status-output.xlsx";
    const bytes = fs.readFileSync(artifact.pathOrKey);
    return new Response(bytes, {
      headers: {
        "Content-Type": artifact.mimeType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      },
    });
  } catch (error) {
    console.error("Download scrape job output failed", error);
    if (isScrapeJobDbConnectionError(error)) {
      return Response.json({ error: "Scrape job database connection timed out. Check DATABASE_URL and restart the dev server." }, { status: 503 });
    }

    return Response.json({ error: "Unable to download scrape job output." }, { status: 500 });
  }
}
