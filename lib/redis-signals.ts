/**
 * Redis signal helper for Architecture A: PHI-free progress relay.
 *
 * Only non-PHI control signals are pushed to Redis.
 * PHI events (row_update, error_screenshot, debug_html, pdf_download)
 * flow exclusively over the direct SSE stream and never touch Redis.
 *
 * Key schema:  job:<jobId>:events  (Redis List)
 * TTL:         15 minutes
 * Format:      Each element is a compact JSON string (abbreviated keys)
 */

import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Signal types (non-PHI only)
// ---------------------------------------------------------------------------

export type ProgressSignal = { t: "p"; c: number; tot: number };
export type LogSignal = { t: "l"; msg: string };
export type RowDoneSignal = { t: "rd"; idx: number };
export type DoneSignal = { t: "done" };
export type ErrorSignal = { t: "err"; msg: string };

export type Signal =
  | ProgressSignal
  | LogSignal
  | RowDoneSignal
  | DoneSignal
  | ErrorSignal;

// ---------------------------------------------------------------------------
// Redis client (lazy singleton — created once per serverless instance)
// ---------------------------------------------------------------------------

let _redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set",
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const EVENTS_TTL_SECONDS = 15 * 60; // 15 minutes

export function jobEventsKey(jobId: string): string {
  return `job:${jobId}:events`;
}

// ---------------------------------------------------------------------------
// pushSignal — called by the US scraper (fire-and-forget, never awaited)
// ---------------------------------------------------------------------------

/**
 * Push a non-PHI signal to Redis for the Edge relay to consume.
 * This is always called fire-and-forget (not awaited) to avoid adding
 * latency to the main SSE stream.
 */
export async function pushSignal(jobId: string, signal: Signal): Promise<void> {
  const redis = getRedisClient();
  const key = jobEventsKey(jobId);
  const payload = JSON.stringify(signal);

  // RPUSH appends to the list; EXPIRE resets the TTL on every write
  await redis.rpush(key, payload);
  await redis.expire(key, EVENTS_TTL_SECONDS);
}

// ---------------------------------------------------------------------------
// consumeSignals — called by the Edge relay poller
// ---------------------------------------------------------------------------

/**
 * Atomically read and remove all pending signals for a job.
 * Uses LRANGE to read then LTRIM to clear — safe for single-reader pattern.
 */
export async function consumeSignals(jobId: string): Promise<Signal[]> {
  const redis = getRedisClient();
  const key = jobEventsKey(jobId);

  // Read all items
  const raw = await redis.lrange(key, 0, -1);
  if (!raw || raw.length === 0) return [];

  // Clear items we just read
  await redis.ltrim(key, raw.length, -1);

  return raw.map((item) => {
    const str = typeof item === "string" ? item : JSON.stringify(item);
    return JSON.parse(str) as Signal;
  });
}

// ---------------------------------------------------------------------------
// expandSignal — expand abbreviated signal back to full SSE event shape
// ---------------------------------------------------------------------------

export type SseEvent = Record<string, unknown>;

export function expandSignal(signal: Signal): SseEvent {
  switch (signal.t) {
    case "p":
      return { type: "progress", completed: signal.c, total: signal.tot };
    case "l":
      return { type: "log", message: signal.msg };
    case "rd":
      return { type: "row_done", rowIndex: signal.idx };
    case "done":
      return { type: "done" };
    case "err":
      return { type: "error", message: signal.msg };
  }
}
