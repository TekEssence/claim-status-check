/**
 * Temporary in-memory blob store for large binary payloads.
 *
 * Instead of sending 100KB+ base64 screenshots/PDFs over the SSE stream
 * (which causes buffering and stalls), we store them here and send only
 * a small URL reference. The browser fetches blobs on-demand via a
 * separate GET endpoint.
 *
 * Items auto-expire after TTL_MS to prevent memory leaks.
 */

import crypto from "node:crypto";

const TTL_MS = 10 * 60 * 1000; // 10 minutes

interface BlobEntry {
  data: Buffer | string;
  contentType: string;
  expiresAt: number;
}

const store = new Map<string, BlobEntry>();

// Periodic cleanup of expired entries
let cleanupScheduled = false;
function scheduleCleanup() {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  const timer = setTimeout(() => {
    cleanupScheduled = false;
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now >= entry.expiresAt) {
        store.delete(key);
      }
    }
    if (store.size > 0) scheduleCleanup();
  }, 60_000); // Check every minute
  // Don't keep the Node process alive just for cleanup
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

/**
 * Store a blob and return a unique key for retrieval.
 */
export function putBlob(
  data: Buffer | string,
  contentType: string,
): string {
  const key = crypto.randomUUID();
  store.set(key, {
    data,
    contentType,
    expiresAt: Date.now() + TTL_MS,
  });
  scheduleCleanup();
  return key;
}

/**
 * Retrieve and delete a blob by key (one-time fetch).
 * Returns null if the blob doesn't exist or has expired.
 */
export function getBlob(key: string): { data: Buffer | string; contentType: string } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  // Delete after retrieval to free memory
  store.delete(key);
  return { data: entry.data, contentType: entry.contentType };
}

/**
 * Retrieve blob without deleting (peek). Useful when browser may re-fetch.
 */
export function peekBlob(key: string): { data: Buffer | string; contentType: string } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return { data: entry.data, contentType: entry.contentType };
}
