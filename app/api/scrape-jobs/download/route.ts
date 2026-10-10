import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";
import { getScrapeJob } from "@/backend/src/jobs/job-store";
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

    if (job.portalId === "iehp") {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "iehp-download-"));
      let streaming = false;
      try {
        const stored = [...(getScrapeJob(jobId)?.events ?? [])].map((event) => event.data);
        const files = [
          ...job.artifacts.map((artifact) => ({ type: artifact.artifactType, filename: artifact.filename, source: artifact.pathOrKey, base64: "" })),
          ...stored.filter((event) => event.type === "pdf_download" || event.type === "output_snapshot").map((event) => ({
            type: String(event.type),
            filename: typeof event.filename === "string" ? event.filename : "",
            source: typeof event.path === "string" ? event.path : "",
            base64: typeof event.base64 === "string" ? event.base64 : "",
          })),
        ];
        for (const file of files) {
          if (file.type !== "pdf_download" && file.type !== "output_snapshot") continue;
          if (!file.filename || (!file.source && !file.base64)) continue;
          const sourceExists = Boolean(file.source && fs.existsSync(file.source));
          if (!sourceExists && !file.base64) continue;
          const folder = file.type === "output_snapshot" ? "results" : file.filename.startsWith("covered_ra_") ? "ra/covered" : "ra/claim";
          const name = path.basename(file.filename.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._-]/g, "_");
          if (!name) continue;
          const destinationDir = path.join(tempDir, folder);
          fs.mkdirSync(destinationDir, { recursive: true });
          const destination = path.join(destinationDir, name);
          if (sourceExists) fs.copyFileSync(file.source, destination);
          else if (file.base64) fs.writeFileSync(destination, Buffer.from(file.base64, "base64"));
        }
        const hasFiles = fs.readdirSync(tempDir).length > 0;
        if (!hasFiles) return Response.json({ error: "No IEHP files are available for this run yet." }, { status: 404 });
        const filename = `iehp_${jobId.replace(/[^a-zA-Z0-9._-]/g, "_")}_files.zip`;
        const output = new PassThrough();
        const archive = (archiver as (format: "zip", options: { store: boolean }) => {
          directory(source: string, destination: string | false): void;
          pipe(stream: PassThrough): void;
          finalize(): Promise<void>;
          on(event: "error" | "warning", listener: (error: Error) => void): void;
        })("zip", { store: true });
        archive.on("error", (error) => output.destroy(error));
        archive.on("warning", (error) => output.destroy(error));
        output.on("close", () => fs.rmSync(tempDir, { recursive: true, force: true }));
        archive.directory(tempDir, false);
        archive.pipe(output);
        void archive.finalize().catch((error) => output.destroy(error));
        streaming = true;
        return new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${filename}"` } });
      } finally {
        if (!streaming) fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    const artifacts = [...job.artifacts].reverse();
    const snapshot = [...(getScrapeJob(jobId)?.events ?? [])].reverse().map(event => event.data).find(event =>
      (event.type === 'output_snapshot' || event.type === 'file_download') &&
      typeof event.filename === 'string' && /\.xlsx?$/i.test(event.filename) && typeof event.base64 === 'string');
    if (snapshot) {
      return new Response(Buffer.from(String(snapshot.base64), 'base64'), { headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${String(snapshot.filename).replace(/["\r\n]/g, '')}"`,
      } });
    }
    const artifact = artifacts.find((candidate) =>
      candidate.artifactType === "output_snapshot" &&
      candidate.pathOrKey &&
      fs.existsSync(candidate.pathOrKey),
    ) ?? artifacts.find((candidate) =>
      candidate.artifactType === "file_download" &&
      candidate.pathOrKey &&
      fs.existsSync(candidate.pathOrKey) &&
      !candidate.filename.toLowerCase().endsWith(".pdf") &&
      candidate.mimeType !== "application/pdf",
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
