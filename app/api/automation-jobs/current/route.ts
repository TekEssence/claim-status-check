import fs from "node:fs";
import { getScrapeJob } from "@/backend/src/jobs/job-store";
import { isAuthDbConnectionError } from "@/lib/auth/db";
import { getSessionFromCookies } from "@/lib/auth/session";
import { getActiveAutomationJobForUser, updateAutomationJob } from "@/lib/automation-jobs/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSessionFromCookies();
    if (!session) return Response.json({ job: null }, { status: 401 });

    let job = await getActiveAutomationJobForUser(session.userId);
    if (job?.status === "running" && !getScrapeJob(job.jobId)) {
      await updateAutomationJob({ jobId: job.jobId, status: "failed" }).catch(() => {});
      job = null;
    }
    if (job) {
      job.artifacts = job.artifacts
        .filter((artifact) => !artifact.pathOrKey || fs.existsSync(artifact.pathOrKey))
        .map((artifact) => {
          if (["error_screenshot", "file_download", "output_snapshot", "debug_html"].includes(artifact.artifactType) && artifact.pathOrKey) {
            return {
              ...artifact,
              contentBase64: fs.readFileSync(artifact.pathOrKey).toString("base64"),
            };
          }
          return artifact;
        });
    }
    return Response.json({ job });
  } catch (error) {
    console.error("Load current automation job failed", error);
    if (isAuthDbConnectionError(error)) {
      return Response.json({ error: "Database connection timed out. Check DATABASE_URL and restart the dev server." }, { status: 503 });
    }
    return Response.json({ error: "Unable to load current automation job." }, { status: 500 });
  }
}
