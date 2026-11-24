import test from "node:test";
import assert from "node:assert/strict";
import type { ScrapeJobEvent } from "../types/job";

test("AWS logs stay live-only across reconnects while one DB poll supplies progress and OTP", async (t) => {
  const originalEnv = { ...process.env };
  const descriptors = new Map(["window", "document", "WebSocket"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const realTimeout = globalThis.setTimeout;
  t.after(() => {
    process.env = originalEnv;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  Object.assign(process.env, { NEXT_PUBLIC_WORKFLOW_API_URL: "https://api.example", NEXT_PUBLIC_WORKFLOW_WS_URL: "wss://live.example" });
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((message: { data: string }) => Promise<void>) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    close() { this.readyState = 3; }
    async emit(event: ScrapeJobEvent) { await this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { hostname: "claims.example" },
    sessionStorage: { getItem: (key: string) => key === "cognito_access_token" ? "test-token" : null },
    setTimeout: (callback: () => void) => realTimeout(callback, 0), clearTimeout,
    addEventListener() {}, removeEventListener() {},
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) => realTimeout(callback, 0)) as unknown as typeof setTimeout);
  const api = await import("./scrape-jobs-api");
  const requests: string[] = [];
  let poll = 0;
  const controller = new AbortController();
  const events: ScrapeJobEvent[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("includeLogs=true")) return new Response(JSON.stringify({ job: { jobId: "job", status: "completed", currentCompleted: 4, totalRows: 4 }, logs: ["Saved history"] }));
    poll++;
    assert.equal(api.hasAwsJobSubscription("job"), true);
    if (poll === 1) {
      await sockets[0].emit({ type: "log", message: "Live line 1" });
      await sockets[0].emit({ type: "progress", completed: 99, total: 999 });
      await sockets[0].emit({ type: "row_progress", current: 100, total: 999 });
    } else {
      sockets[0].close(); sockets[0].onclose?.();
      await new Promise(resolve => realTimeout(resolve, 0));
      assert.equal(sockets.length, 2);
      await sockets[1].emit({ type: "log", message: "Live line 2" });
      await sockets[1].emit({ type: "progress", completed: 0, total: 0 });
    }
    return new Response(JSON.stringify({
      job: { status: poll === 1 ? "waiting_otp" : "completed", currentCompleted: poll === 1 ? 3 : 4, totalRows: 4 },
      events: [{ id: 1, payload: { type: "input_request", inputName: "otp", message: "Enter OTP" } }],
      logs: ["Stale CloudWatch snapshot must not be replayed"],
      artifacts: [{ artifactType: "file_download", filename: "output.xlsx", bucket: "outputs", s3Key: "job/output.xlsx" }],
    }));
  });
  await api.subscribeToScrapeJobEvents({ jobId: "job", signal: controller.signal, autoDownload: false, onEvent: event => { events.push(event); }, onStreamError: error => { throw error; } });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => !url.includes("includeLogs")));
  assert.deepEqual(events.filter(event => event.type === "progress").map(event => [event.completed, event.total]), [[3, 4], [4, 4]]);
  assert.deepEqual(events.filter(event => event.type === "log").map(event => event.message), ["Live line 1", "Live line 2"]);
  assert.equal(events.filter(event => event.type === "input_request").length, 1);
  assert.equal(api.hasAwsJobSubscription("job"), false);
  assert.equal(sockets[1].readyState, 3);
  assert.deepEqual((await api.getScrapeJobDetails("job")).logs, ["Saved history"]);
  assert.equal(requests.filter(url => url.includes("includeLogs=true")).length, 1);

  const aborted = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    aborted.abort();
    return new Response(JSON.stringify({ job: { status: "running", currentCompleted: 0, totalRows: 0 } }));
  });
  const lateEvents: ScrapeJobEvent[] = [];
  await api.subscribeToScrapeJobEvents({ jobId: "old-job", signal: aborted.signal, onEvent: event => { lateEvents.push(event); }, onStreamError: error => { throw error; } });
  assert.deepEqual(lateEvents, []);
  assert.equal(api.hasAwsJobSubscription("old-job"), false);
});
