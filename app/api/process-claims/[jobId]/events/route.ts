import { getProcessClaimJob, subscribeToProcessClaimJob, type ProcessClaimJobEvent } from "../../jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getLastEventId(req: Request, url: URL): number {
  const fromQuery = Number(url.searchParams.get("after") || "0");
  const fromHeader = Number(req.headers.get("last-event-id") || "0");
  const lastEventId = Math.max(
    Number.isFinite(fromQuery) ? fromQuery : 0,
    Number.isFinite(fromHeader) ? fromHeader : 0,
  );
  return lastEventId > 0 ? lastEventId : 0;
}

function isTerminalJobStatus(status: string): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getProcessClaimJob(jobId);
  const encoder = new TextEncoder();

  if (!job) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("id: 1\n"));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "error",
          message: "Process claim job not found. The serverless instance may have restarted before the event stream connected.",
        })}\n\n`));
        controller.enqueue(encoder.encode("id: 2\n"));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: sseHeaders(),
    });
  }

  const url = new URL(req.url);
  const afterEventId = getLastEventId(req, url);
  let cleanup = () => {};
  const abortHandler = () => cleanup();
  req.signal.addEventListener("abort", abortHandler, { once: true });

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let keepAliveInterval: ReturnType<typeof setInterval> | undefined;
      let readyToCloseOnDone = false;
      let closeAfterSubscribe = false;

      cleanup = () => {
        if (closed) return;
        closed = true;
        if (keepAliveInterval) clearInterval(keepAliveInterval);
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

      const send = (event: ProcessClaimJobEvent) => {
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

      keepAliveInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close();
        }
      }, 1000);

      unsubscribe = subscribeToProcessClaimJob(jobId, afterEventId, send);
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

  return new Response(stream, {
    headers: sseHeaders(),
  });
}
