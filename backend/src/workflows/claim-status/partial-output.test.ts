import assert from "node:assert/strict";
import test from "node:test";
import { emitPartialOutputSnapshot } from "./partial-output";
import type { ScraperContext } from "./types";

test("a completed row produces a downloadable snapshot without stopping the run on storage failure", async () => {
  const events: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const workbook = Buffer.from("partial workbook");
  const context = {
    jobId: "job-1",
    portalId: "waystar",
    emit: async (event: Record<string, unknown>) => { events.push(event); },
    log: async (event: { message: string }) => { warnings.push(event.message); },
  } as ScraperContext;

  await emitPartialOutputSnapshot(context, "waystar_output_snapshot.xlsx", workbook, 1, 3);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "output_snapshot");
  assert.equal(events[0]?.completed, 1);
  assert.deepEqual(Buffer.from(String(events[0]?.base64), "base64"), workbook);

  context.emit = async () => { throw new Error("S3 unavailable"); };
  await assert.doesNotReject(emitPartialOutputSnapshot(context, "waystar_output_snapshot.xlsx", workbook, 2, 3));
  assert.match(warnings[0] ?? "", /S3 unavailable/);
});
