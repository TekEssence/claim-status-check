import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cancelScrapeJob,
  createScrapeJob,
  emitScrapeJobEvent,
  getScrapeJob,
  registerScrapeJobEmitListener,
  subscribeToScrapeJob,
  type ScrapeJobEvent,
} from "@/backend/src/jobs/job-store";
import { getSessionFromCookies } from "@/lib/auth/session";
import {
  appendScrapeJobArtifact,
  appendScrapeJobLog,
  createPersistentScrapeJob,
  getActiveScrapeJobForUser,
  getScrapeJobByIdForUser,
  updateScrapeJobSnapshot,
} from "@/lib/scrape-jobs/db";
import { getScraper } from "@/backend/src/scrapers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

let persistenceListenerRegistered = false;

function ensurePersistenceListenerRegistered() {
  if (persistenceListenerRegistered) return;
  persistenceListenerRegistered = true;

  registerScrapeJobEmitListener((jobId, data) => {
    void persistScrapeJobEvent(jobId, data);
  });
}

export async function POST(req: Request) {
  ensurePersistenceListenerRegistered();
  const session = await getSessionFromCookies();
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const formData = await req.formData();
  const portalId = getPortalId(formData);
  const scraper = getScraper(portalId);
  const input = scraper.validateInput(formData);
  const requestedJobId = getRequestedJobId(formData);
  const totalRows = getTotalRows(formData);
  const startIndex = getStartIndex(formData);
  const existingActiveJob = await getNormalizedActiveScrapeJobForUser(session.userId);

  if (!requestedJobId && existingActiveJob) {
    return Response.json(
      { error: "Another run is already active for this user. Please wait for it to finish or reconnect to it.", jobId: existingActiveJob.jobId },
      { status: 409 },
    );
  }

  if (requestedJobId) {
    if (!existingActiveJob || existingActiveJob.jobId !== requestedJobId) {
      return Response.json({ error: "The requested run is no longer active for this user." }, { status: 409 });
    }
    const ownedJob = await getScrapeJobByIdForUser(requestedJobId, session.userId);
    if (!ownedJob) {
      return Response.json({ error: "Run not found for this user." }, { status: 404 });
    }
  }

  const job = createScrapeJob(requestedJobId || undefined);
  await createPersistentScrapeJob({
    jobId: job.id,
    userId: session.userId,
    portalId,
    claimFileName: getOptionalString(formData, "claimFileName"),
    loginFileName: getOptionalString(formData, "loginFileName"),
    totalRows,
    currentCompleted: startIndex,
  });

  scraper.run(input, {
    jobId: job.id,
    portalId,
    emit: async (event) => {
      emitScrapeJobEvent(job.id, event);
    },
    isCancelled: () => {
      const currentJob = getScrapeJob(job.id);
      return currentJob?.status === "cancelled";
    },
    log: async (event) => {
      emitScrapeJobEvent(job.id, {
        type: "log",
        message: event.message,
        level: event.level,
        eventName: event.eventName,
        rowIndex: event.rowIndex,
        meta: event.meta,
      });
    },
  }).then(async () => {
    const currentJob = getScrapeJob(job.id);
    const completed = currentJob?.currentCompleted ?? startIndex;
    const finalStatus = completed < totalRows ? "waiting_resume" : "completed";
    await updateScrapeJobSnapshot({
      jobId: job.id,
      status: finalStatus,
      currentCompleted: completed,
      totalRows,
    }).catch(() => {});
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : "Unexpected automation error.";
    emitScrapeJobEvent(job.id, { type: "error", message });
    emitScrapeJobEvent(job.id, { type: "done" });
    await updateScrapeJobSnapshot({
      jobId: job.id,
      status: "failed",
      currentCompleted: getScrapeJob(job.id)?.currentCompleted ?? startIndex,
      totalRows,
    }).catch(() => {});
  });

  return Response.json({ jobId: job.id, portalId });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");

  if (!jobId) {
    return Response.json({ error: "Missing scrape jobId." }, { status: 400 });
  }

  return streamScrapeJobEvents(req, jobId, getLastEventId(req, url));
}

export async function DELETE(req: Request) {
  ensurePersistenceListenerRegistered();
  const session = await getSessionFromCookies();
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId")?.trim() || "";
  if (!jobId) {
    return Response.json({ error: "Missing scrape jobId." }, { status: 400 });
  }

  const ownedJob = await getScrapeJobByIdForUser(jobId, session.userId);
  if (!ownedJob) {
    return Response.json({ error: "Run not found for this user." }, { status: 404 });
  }

  const cancelled = cancelScrapeJob(jobId, "Scrape job cancelled because Excel could not be updated.");
  if (!cancelled) {
    return Response.json({ ok: true, alreadyStopped: true });
  }

  await updateScrapeJobSnapshot({
    jobId,
    status: "cancelled",
    currentCompleted: getScrapeJob(jobId)?.currentCompleted ?? ownedJob.currentCompleted,
    totalRows: ownedJob.totalRows,
  }).catch(() => {});

  return Response.json({ ok: true });
}

function getLastEventId(req: Request, url: URL): number {
  const fromQuery = Number(url.searchParams.get("after") || "0");
  const fromHeader = Number(req.headers.get("last-event-id") || "0");
  const lastEventId = Math.max(
    Number.isFinite(fromQuery) ? fromQuery : 0,
    Number.isFinite(fromHeader) ? fromHeader : 0,
  );
  return lastEventId > 0 ? lastEventId : 0;
}

async function getNormalizedActiveScrapeJobForUser(userId: string) {
  const activeJob = await getActiveScrapeJobForUser(userId);
  if (!activeJob) return null;

  const inMemoryJob = getScrapeJob(activeJob.jobId);
  if (activeJob.status === "running" && !inMemoryJob) {
    if (activeJob.totalRows > 0 && activeJob.currentCompleted < activeJob.totalRows) {
      await updateScrapeJobSnapshot({
        jobId: activeJob.jobId,
        status: "waiting_resume",
        currentCompleted: activeJob.currentCompleted,
        totalRows: activeJob.totalRows,
      }).catch(() => {});

      return {
        ...activeJob,
        status: "waiting_resume" as const,
      };
    }

    await updateScrapeJobSnapshot({
      jobId: activeJob.jobId,
      status: "completed",
      currentCompleted: activeJob.currentCompleted,
      totalRows: activeJob.totalRows,
    }).catch(() => {});

    return null;
  }

  return activeJob;
}

function getPortalId(formData: FormData): string {
  const portalId = formData.get("portalId");
  return typeof portalId === "string" && portalId.trim() ? portalId.trim() : "iehp";
}

function getRequestedJobId(formData: FormData): string {
  const requestedJobId = formData.get("existingJobId");
  return typeof requestedJobId === "string" && requestedJobId.trim() ? requestedJobId.trim() : "";
}

function getOptionalString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getStartIndex(formData: FormData): number {
  const value = Number(getOptionalString(formData, "startIndex") || "0");
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function getTotalRows(formData: FormData): number {
  const rawClaimRows = formData.get("claimRows");
  if (typeof rawClaimRows !== "string") return 0;
  try {
    const parsed = JSON.parse(rawClaimRows);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

async function persistScrapeJobEvent(jobId: string, data: Record<string, unknown>): Promise<void> {
  if (data.type === "log" && typeof data.message === "string" && data.message.trim()) {
    await appendScrapeJobLog(jobId, data.message).catch(() => {});
    return;
  }

  if (data.type === "progress") {
    const completed = typeof data.completed === "number" ? data.completed : undefined;
    const total = typeof data.total === "number" ? data.total : undefined;
    await updateScrapeJobSnapshot({
      jobId,
      status: "running",
      currentCompleted: completed,
      totalRows: total,
    }).catch(() => {});
    return;
  }

  if (data.type === "error_screenshot" || data.type === "debug_html" || data.type === "pdf_download" || data.type === "file_download") {
    const persistedPath = getArtifactPathForPersistence(jobId, data);
    await appendScrapeJobArtifact({
      jobId,
      rowIndex: typeof data.index === "number" ? data.index : null,
      artifactType: String(data.type),
      filename: typeof data.filename === "string" ? data.filename : undefined,
      mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
      pathOrKey: persistedPath || (typeof data.path === "string" ? data.path : undefined),
    }).catch(() => {});
    return;
  }

  if (data.type === "error") {
    await updateScrapeJobSnapshot({ jobId, status: "failed" }).catch(() => {});
    if (typeof data.message === "string" && data.message.trim()) {
      await appendScrapeJobLog(jobId, `ERROR: ${data.message}`).catch(() => {});
    }
    return;
  }

  if (data.type === "cancelled") {
    await updateScrapeJobSnapshot({ jobId, status: "cancelled" }).catch(() => {});
  }
}

function getArtifactPathForPersistence(jobId: string, data: Record<string, unknown>): string {
  const existingPath = typeof data.path === "string" ? data.path : "";
  if (existingPath && fs.existsSync(existingPath)) {
    return existingPath;
  }

  return persistArtifactPayload(jobId, data);
}

function persistArtifactPayload(jobId: string, data: Record<string, unknown>): string {
  try {
    const artifactType = String(data.type ?? "artifact");
    const artifactDir = path.join(os.tmpdir(), "iehp-scrape-artifacts", jobId);
    fs.mkdirSync(artifactDir, { recursive: true });

    if (artifactType === "error_screenshot" && typeof data.image === "string" && data.image) {
      const filePath = path.join(
        artifactDir,
        `row_${typeof data.index === "number" ? data.index + 1 : "unknown"}_${Date.now()}.jpg`,
      );
      fs.writeFileSync(filePath, Buffer.from(data.image, "base64"));
      return filePath;
    }

    if (artifactType === "debug_html" && typeof data.html === "string" && data.html) {
      const filePath = path.join(
        artifactDir,
        typeof data.filename === "string" && data.filename ? data.filename : `debug_${Date.now()}.html`,
      );
      fs.writeFileSync(filePath, data.html, "utf8");
      return filePath;
    }

    if ((artifactType === "pdf_download" || artifactType === "file_download") && typeof data.base64 === "string" && data.base64) {
      const fallbackExt = artifactType === "pdf_download" ? ".pdf" : ".bin";
      const filePath = path.join(
        artifactDir,
        typeof data.filename === "string" && data.filename ? data.filename : `artifact_${Date.now()}${fallbackExt}`,
      );
      fs.writeFileSync(filePath, Buffer.from(data.base64, "base64"));
      return filePath;
    }
  } catch {
    // Persistence is best-effort. Live SSE should still continue.
  }

  return "";
}

function isTerminalJobStatus(status: string): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
  };
}

function streamScrapeJobEvents(req: Request, jobId: string, afterEventId: number): Response {
  const encoder = new TextEncoder();
  const job = getScrapeJob(jobId);

  if (!job) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("id: 1\n"));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "error",
          message: "Scrape job not found. Please start processing again.",
        })}\n\n`));
        controller.enqueue(encoder.encode("id: 2\n"));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      },
    });

    return new Response(stream, { headers: sseHeaders() });
  }

  let cleanup = () => {};
  const abortHandler = () => cleanup();
  req.signal.addEventListener("abort", abortHandler, { once: true });

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const keepAliveInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close();
        }
      }, 1000);
      let readyToCloseOnDone = false;
      let closeAfterSubscribe = false;

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveInterval);
        unsubscribe();
        req.signal.removeEventListener("abort", abortHandler);
      };

      const close = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // The client may already have disconnected.
        }
      };

      const send = (event: ScrapeJobEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`id: ${event.id}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event.data)}\n\n`));
          if (event.data.type === "done") {
            if (readyToCloseOnDone) {
              close();
            } else {
              closeAfterSubscribe = true;
            }
          }
        } catch {
          close();
        }
      };

      unsubscribe = subscribeToScrapeJob(jobId, afterEventId, send);
      readyToCloseOnDone = true;
      if (closeAfterSubscribe) {
        close();
        return;
      }

      if (isTerminalJobStatus(job.status)) {
        const hasDoneEvent = job.events.some((event) => event.id > afterEventId && event.data.type === "done");
        if (!hasDoneEvent) {
          send({ id: job.events.length + 1, data: { type: "done" } });
        }
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
