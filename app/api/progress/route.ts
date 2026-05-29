/**
 * GET /api/progress?jobId=<uuid>
 *
 * Edge SSE relay — runs in Vercel Edge Runtime (routed to nearest region,
 * e.g. Mumbai for India users). Polls Upstash Redis for non-PHI progress
 * signals and streams them to the browser as SSE events.
 *
 * Architecture A: PHI Never Touches Upstash
 * - Only progress, log, row_done, done, error signals come through here
 * - All PHI events (row_update, screenshots, PDFs) flow on the direct
 *   SSE stream from /api/process-claims, completely bypassing Redis
 */

export const runtime = "edge";
export const dynamic = "force-dynamic";

import { consumeSignals, expandSignal } from "@/lib/redis-signals";

const POLL_INTERVAL_MS = 200;        // Poll Redis every 200ms
const MAX_DURATION_MS = 5 * 60_000; // 5-minute guard timeout
const PING_INTERVAL_MS = 20_000;     // SSE keepalive comment every 20s

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  if (!jobId || !/^[0-9a-f-]{36}$/.test(jobId)) {
    return new Response("Missing or invalid jobId", { status: 400 });
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  // Return the response immediately — Edge runtime streams without buffering
  const response = new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });

  // Fire-and-forget polling loop
  (async () => {
    const startTime = Date.now();
    let finished = false;
    let lastPingTime = Date.now();

    // Send initial padding to bust any proxy buffer (4KB is enough for Edge)
    await writer.write(
      encoder.encode(`data: ${JSON.stringify({ type: "padding", payload: "x".repeat(4096) })}\n\n`),
    );

    while (!finished) {
      // Guard: max duration
      if (Date.now() - startTime > MAX_DURATION_MS) {
        await writer.write(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Progress relay timed out" })}\n\n`),
        );
        break;
      }

      // SSE keepalive ping every 20s
      if (Date.now() - lastPingTime > PING_INTERVAL_MS) {
        await writer.write(encoder.encode(": ping\n\n")).catch(() => {});
        lastPingTime = Date.now();
      }

      try {
        const signals = await consumeSignals(jobId);

        for (const signal of signals) {
          const event = expandSignal(signal);
          await writer.write(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );

          // Terminate relay when job is complete or errored
          if (signal.t === "done" || signal.t === "err") {
            finished = true;
            break;
          }
        }
      } catch (err) {
        // Redis error — log and continue (don't crash the relay)
        console.error("[progress relay] Redis poll error:", err);
      }

      if (!finished) {
        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }

    await writer.close().catch(() => {});
  })();

  return response;
}
