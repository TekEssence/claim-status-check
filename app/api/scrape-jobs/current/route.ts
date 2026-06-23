import fs from "node:fs";
import { getSessionFromCookies } from "@/lib/auth/session";
import { getActiveScrapeJobForUser } from "@/lib/scrape-jobs/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionFromCookies();
  if (!session) {
    return Response.json({ job: null }, { status: 401 });
  }

  const job = await getActiveScrapeJobForUser(session.userId);
  if (job) {
    job.artifacts = job.artifacts
      .filter((artifact) => artifact.artifactType !== "error_screenshot" || !artifact.pathOrKey || fs.existsSync(artifact.pathOrKey))
      .map((artifact) => {
        if (
          artifact.artifactType === "error_screenshot" &&
          artifact.pathOrKey &&
          fs.existsSync(artifact.pathOrKey)
        ) {
          return {
            ...artifact,
            contentBase64: fs.readFileSync(artifact.pathOrKey).toString("base64"),
          };
        }
        return artifact;
      });
  }
  return Response.json({ job });
}
