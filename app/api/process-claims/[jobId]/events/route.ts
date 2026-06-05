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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getProcessClaimJob(jobId);

  if (!job) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "error",
          message: "Process claim job not found. The serverless instance may have restarted before the event stream connected.",
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Content-Encoding": "none",
      },
    });
  }

  const url = new URL(req.url);
  const afterEventId = getLastEventId(req, url);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let keepAliveInterval: ReturnType<typeof setInterval>;
      let readyToCloseOnDone = false;
      let closeAfterSubscribe = false;

      const close = () => {
        if (closed) return;
        closed = true;
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        unsubscribe();
        controller.close();
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

      if (job.status === "done" || job.status === "error") {
        const hasDoneEvent = job.events.some((event) => event.id > afterEventId && event.data.type === "done");
        if (!hasDoneEvent) {
          send({ id: job.events.length + 1, data: { type: "done" } });
        }
      }
    },
    cancel() {
      // Cleanup is handled by the controller error path or done event.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "none",
    },
  });
}
