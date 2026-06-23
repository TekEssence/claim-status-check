import fs from "node:fs";
import { getScrapeJob } from "@/backend/src/jobs/job-store";
import { getSessionFromCookies } from "@/lib/auth/session";
import { getActiveScrapeJobForUser, updateScrapeJobSnapshot } from "@/lib/scrape-jobs/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionFromCookies();
  if (!session) {
    return Response.json({ job: null }, { status: 401 });
  }

  let job = await getActiveScrapeJobForUser(session.userId);
  if (job && job.status === "running" && !getScrapeJob(job.jobId)) {
    if (job.totalRows > 0 && job.currentCompleted < job.totalRows) {
      await updateScrapeJobSnapshot({
        jobId: job.jobId,
        status: "waiting_resume",
        currentCompleted: job.currentCompleted,
        totalRows: job.totalRows,
      }).catch(() => {});
      job = { ...job, status: "waiting_resume" };
    } else {
      await updateScrapeJobSnapshot({
        jobId: job.jobId,
        status: "completed",
        currentCompleted: job.currentCompleted,
        totalRows: job.totalRows,
      }).catch(() => {});
      job = null;
    }
  }
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
