import fs from "node:fs";
import { getScrapeJob } from "@/backend/src/jobs/job-store";
import { isAuthDbConnectionError } from "@/lib/auth/db";
import { getSessionFromCookies } from "@/lib/auth/session";
import { getActiveScrapeJobForUser, isScrapeJobDbConnectionError, updateScrapeJobSnapshot } from "@/lib/scrape-jobs/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return Response.json({ job: null }, { status: 401 });
    }

    let job = await getActiveScrapeJobForUser(session.userId);
    if (job && job.status === "waiting_resume" && job.portalId !== "iehp") {
      await updateScrapeJobSnapshot({
        jobId: job.jobId,
        status: "failed",
        currentCompleted: job.currentCompleted,
        totalRows: job.totalRows,
      }).catch(() => {});
      job = null;
    }
    if (job && job.status === "running" && !getScrapeJob(job.jobId)) {
      if (job.portalId === "iehp" && job.totalRows > 0 && job.currentCompleted < job.totalRows) {
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
            (artifact.artifactType === "file_download" || artifact.artifactType === "output_snapshot") &&
            artifact.pathOrKey &&
            fs.existsSync(artifact.pathOrKey)
          ) {
            return {
              ...artifact,
              contentBase64: fs.readFileSync(artifact.pathOrKey).toString("base64"),
            };
          }
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
          if (
            artifact.artifactType === "debug_html" &&
            artifact.pathOrKey &&
            fs.existsSync(artifact.pathOrKey)
          ) {
            return {
              ...artifact,
              contentText: fs.readFileSync(artifact.pathOrKey, "utf8"),
            };
          }
          return artifact;
        });
    }
    return Response.json({ job });
  } catch (error) {
    console.error("Load current scrape job failed", error);
    if (isAuthDbConnectionError(error) || isScrapeJobDbConnectionError(error)) {
      return Response.json({ error: "Database connection timed out. Check DATABASE_URL and restart the dev server." }, { status: 503 });
    }

    return Response.json({ error: "Unable to load current scrape job." }, { status: 500 });
  }
}
