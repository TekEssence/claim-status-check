import ExcelJS from "exceljs";
import type { ServiceRowResult, ServiceRowStatus } from "../service/service-contract";
import type { ServiceWorkbookArtifact } from "../service/iehp-snapshot";
import { validateWorkerManifest, type WorkerResultManifest } from "../service/worker-result-contract";
import { CLAIM_STATUS_OUTPUT_HEADERS } from "../../workflows/claim-status/output-columns";
import { isWorkerOutcome, WORKER_OUTCOME_COLUMN } from "../../workflows/claim-status/worker-outcome";

type Detail = Record<string, string | number | null>;
function cellValue(cell: ExcelJS.Cell): string | number | null {
  const value = cell.formula ? cell.result : cell.value;
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  return String(value).trim();
}

function sheetRows(sheet?: ExcelJS.Worksheet): Detail[] {
  if (!sheet) return [];
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(String(cellValue(cell) ?? ""), column));
  const rows: Detail[] = [];
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row: Detail = {};
    for (const [header, column] of headers) if (header) row[header] = cellValue(sheet.getRow(index).getCell(column));
    if (Object.values(row).some(value => value !== null && value !== "")) rows.push(row);
  }
  return rows;
}

function rowRef(row: Detail, refs: string[], oneBasedInputRow: boolean): string | null {
  const direct = row["Client Row Ref"] || row.client_row_ref;
  if (direct) {
    if (typeof direct !== "string" || !refs.includes(direct)) throw new Error("Worker output has an unexpected claim reference.");
    return direct;
  }
  const header = ["input_row_id", "input_row_number", "Input Row", "inputRowId", "sno"].find(key => row[key] !== null && row[key] !== undefined && row[key] !== "");
  if (!header) return null;
  const raw = String(row[header]).trim();
  if (!/^\d+\.?$/.test(raw)) throw new Error("Worker output has an invalid input row number.");
  const index = Number.parseInt(raw, 10) - (header === "sno" || (header === "Input Row" && oneBasedInputRow) ? 1 : 2);
  if (!refs[index]) throw new Error("Worker output has an unexpected input row number.");
  return refs[index];
}

const text = (value: unknown) => String(value ?? "").trim();
const messageFor = (row: Detail) => ["bot_notes", "BotClaimStatusCheckError", "BotStatusError", "Bot Message", "Remarks", "notes", "error_message", "Error Message", "error", "Error", "message", "reason"]
  .map(key => text(row[key])).filter(Boolean).join(" | ");

/** Shared by Fargate publication and stop-confirmed cancellation recovery. Requires
 * an explicit processing outcome; native fields/codes/payments cannot create success. */
export async function completedWorkerWorkbookResults(bytes: Uint8Array, expectedRefs: string[]): Promise<ServiceRowResult[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const output = book.getWorksheet("Output") ?? book.worksheets[0];
  const rows = sheetRows(output);
  // Inspect the schema even when there are no output rows yet (error-only
  // snapshots still use the same input-index convention).
  let oneBasedInputRow = false;
  output?.getRow(1).eachCell(cell => { if (cellValue(cell) === "sno") oneBasedInputRow = true; });
  const grouped = new Map<string, Detail[]>();
  const inputRefs = new Map<string, string>();
  let continuationRef: string | null = null;
  for (const row of rows) {
    const directRef = rowRef(row, expectedRefs, oneBasedInputRow);
    if (directRef && row.input_row_id != null && row.input_row_id !== "") {
      const key = String(row.input_row_id);
      if (inputRefs.has(key) && inputRefs.get(key) !== directRef) throw new Error("Worker input row maps to multiple claim references.");
      inputRefs.set(key, directRef);
    }
    if (directRef) continuationRef = directRef;
    const ref = directRef ?? (Object.hasOwn(row, "sno") ? continuationRef : null);
    if (ref) grouped.set(ref, [...(grouped.get(ref) ?? []), row]);
  }
  const errors = new Map<string, Detail[]>();
  for (const name of ["Error", "Error Log"]) {
    for (const row of sheetRows(book.getWorksheet(name))) {
      // Diagnostic logs without a stable input row cannot finalize claims.
      // Prefer the output's verified native-ID mapping: Availity diagnostics
      // use one-based IDs rather than physical Excel row numbers.
      const ref = row["Client Row Ref"] || row.client_row_ref ? rowRef(row, expectedRefs, oneBasedInputRow)
        : inputRefs.get(String(row.input_row_id)) ?? rowRef(row, expectedRefs, oneBasedInputRow);
      if (ref && messageFor(row)) errors.set(ref, [...(errors.get(ref) ?? []), row]);
    }
  }
  return expectedRefs.flatMap(ref => {
    const details = grouped.get(ref) ?? [];
    const failed = errors.get(ref) ?? [];
    const outcomes = details.map(row => row[WORKER_OUTCOME_COLUMN]);
    // A partially populated multi-detail group must not be frozen early.
    if (outcomes.some(outcome => !isWorkerOutcome(outcome) || outcome === "INCOMPLETE")) return [];
    if (!outcomes.length && !failed.length) return [];
    // Error-sheet diagnostics accompany intentionally skipped rows too. Only a
    // fully skipped detail group is SKIPPED; mixed processed/skipped groups fail.
    const skipped = outcomes.length > 0 && outcomes.every(outcome => outcome === "SKIPPED");
    const status: ServiceRowStatus = skipped ? "SKIPPED" : failed.length || outcomes.includes("FAILED") || outcomes.includes("SKIPPED") ? "FAILED"
      : outcomes.includes("ACTION_REQUIRED") ? "ACTION_REQUIRED"
        : outcomes.every(outcome => outcome === "NO_MATCH") ? "NO_MATCH" : "SUCCESS";
    const allDetails = [...details, ...failed];
    const message = [...new Set(allDetails.map(messageFor).filter(Boolean))].join(" | ");
    const canonical: Detail = {};
    for (const header of CLAIM_STATUS_OUTPUT_HEADERS) {
      const values = details.map(row => row[header] ?? null);
      const first = values[0];
      canonical[header] = first != null && values.every(value => value != null && String(value) === String(first)) ? first : null;
    }
    return [{
      client_row_ref: ref, status,
      result: { ...canonical, worker_result_version: 1, worker_outcome: status,
        // Display text only. None of these adjudication/native fields can
        // determine the processing outcome selected above.
        claim_status: [...new Set(details.map(row => text(row.BotClaimStatus || row["Bot Claim Status"] || row["Claim Status"]
          || row.claim_outcome || row.final_status || row.status || row.BotClaimStatusCheck || row.bot_overall_result)).filter(Boolean))].join("; "),
        claim_details: [...new Set(details.map(row => text(row.BotClaimDetails || row["Claim Status - Final Status"])).filter(Boolean))].join("\n\n"),
        detail_rows: allDetails },
      error_category: status === "SUCCESS" ? null : /unsupported payer|payer.*not supported/i.test(message) ? "UNSUPPORTED_PAYER" : status,
      error_message: status === "SUCCESS" ? null : message || null,
    }];
  });
}

/** Serialized, monotonic worker snapshots. The DB ledger remains the public
 * cursor authority; this manifest transports only worker-finalized outcomes. */
export function createClaimResultPublisher(input: {
  jobId: string; expectedRefs: string[]; initial?: WorkerResultManifest | null;
  save: (manifest: WorkerResultManifest) => Promise<void>;
}) {
  const initial = validateWorkerManifest(input.initial ?? { version: 1, producer: "claim-status-worker", job_id: input.jobId,
    finalized: false, results: [], artifact: null }, input.jobId, input.expectedRefs);
  const recorded = new Map((initial?.results ?? []).map(row => [row.client_row_ref, row]));
  let artifact = initial?.artifact ?? null;
  let closed = initial?.finalized ?? false;
  let durable = structuredClone(initial);
  let queue: Promise<unknown> = Promise.resolve();
  const snapshot = (): WorkerResultManifest => ({ version: 1, producer: "claim-status-worker", job_id: input.jobId,
    finalized: closed, results: [...recorded.values()], artifact });
  const save = async () => {
    const next = snapshot();
    validateWorkerManifest(next, input.jobId, input.expectedRefs);
    await input.save(next);
    durable = structuredClone(next);
  };
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  return {
    initialize: () => serialize(save),
    publishWorkbook: (bytes: Uint8Array, workbook: ServiceWorkbookArtifact) => serialize(async () => {
      if (closed) return;
      const results = await completedWorkerWorkbookResults(bytes, input.expectedRefs);
      for (const row of results) if (!recorded.has(row.client_row_ref)) recorded.set(row.client_row_ref, row);
      artifact = workbook;
      await save();
    }),
    finish: (reason: "OUTPUT_MISSING" | "CANCELLED" | "TASK_FAILED" | "DEADLINE_EXCEEDED",
      message = "The worker ended without completing this claim.") => serialize(async () => {
      for (const ref of input.expectedRefs) {
        if (recorded.has(ref)) continue;
        recorded.set(ref, { client_row_ref: ref, status: "FAILED", result: {
          ...Object.fromEntries(CLAIM_STATUS_OUTPUT_HEADERS.map(header => [header, null])),
          worker_result_version: 1, worker_outcome: "FAILED", detail_rows: [], claim_status: "", claim_details: "",
        }, error_category: reason, error_message: message });
      }
      closed = true;
      await save();
      return structuredClone(durable);
    }),
    getSnapshot: () => structuredClone(durable),
  };
}
