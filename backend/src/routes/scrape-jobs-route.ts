import {
  createScrapeJob,
  emitScrapeJobEvent,
  getScrapeJob,
  subscribeToScrapeJob,
  type ScrapeJobEvent,
} from "@/backend/src/jobs/job-store";
import { getScraper } from "@/backend/src/scrapers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const formData = await req.formData();
  const portalId = getPortalId(formData);
  const scraper = getScraper(portalId);
  const input = scraper.validateInput(formData);
  const job = createScrapeJob();

  scraper.run(input, {
    jobId: job.id,
    portalId,
    emit: async (event) => {
      emitScrapeJobEvent(job.id, event);
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
  }).catch((error) => {
    const message = error instanceof Error ? error.message : "Unexpected automation error.";
    emitScrapeJobEvent(job.id, { type: "error", message });
    emitScrapeJobEvent(job.id, { type: "done" });
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

function getLastEventId(req: Request, url: URL): number {
  const fromQuery = Number(url.searchParams.get("after") || "0");
  const fromHeader = Number(req.headers.get("last-event-id") || "0");
  const lastEventId = Math.max(
    Number.isFinite(fromQuery) ? fromQuery : 0,
    Number.isFinite(fromHeader) ? fromHeader : 0,
  );
  return lastEventId > 0 ? lastEventId : 0;
}

function getPortalId(formData: FormData): string {
  const portalId = formData.get("portalId");
  return typeof portalId === "string" && portalId.trim() ? portalId.trim() : "iehp";
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
