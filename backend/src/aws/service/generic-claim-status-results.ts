import ExcelJS from "exceljs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { listArtifactsForJob } from "../runtime/workflow-db";
import { loadServiceExpectedRefs, type ServiceWorkbookArtifact } from "./iehp-snapshot";
import type { ServiceResultSummary, ServiceRowResult, ServiceRowStatus } from "./iehp-results";
import type { GenericClaimStatusServicePortalId } from "./generic-claim-status-input";

type ServiceJob = Parameters<typeof loadServiceExpectedRefs>[0];
type Detail = Record<string, string>;
const ROW_NUMBER_HEADERS = ["input_row_id", "input_row_number", "Input Row", "inputRowId", "sno"];
const NO_MATCH = /\b(?:no[ _-]?(?:matching[ _-]?(?:data|claims?)|data|results?|claims?|match)\b|not[ _-]?found\b)/i;
const FAILURE = /\b(error|failed|failure|invalid|skipped|timeout|timed out)\b/i;
const ACTION = /\b(otp|mfa|captcha|verification required|action required)\b/i;

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  if (typeof value === "object" && "result" in value) return String(value.result ?? "").trim();
  return String(value).trim();
}

function sheetRows(sheet: ExcelJS.Worksheet | undefined): Detail[] {
  if (!sheet) return [];
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, column) => { headers[column] = cellText(cell.value); });
  const rows: Detail[] = [];
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const record: Detail = {};
    sheet.getRow(index).eachCell((cell, column) => {
      const header = headers[column];
      if (header) record[header] = cellText(cell.value);
    });
    if (Object.values(record).some(Boolean)) rows.push(record);
  }
  return rows;
}

function sourceRef(row: Detail, expectedRefs: string[], portalId: GenericClaimStatusServicePortalId): string | null {
  const direct = row["Client Row Ref"];
  if (direct) {
    if (!expectedRefs.includes(direct)) throw new Error(`${portalId} output has an unexpected Client Row Ref.`);
    return direct;
  }
  const header = ROW_NUMBER_HEADERS.find((name) => row[name]);
  if (!header) return null;
  const number = Number.parseInt(row[header], 10);
  if (!Number.isInteger(number)) return null;
  const index = number - (header === "sno" || (portalId === "waystar" && header === "Input Row") ? 1 : 2);
  if (index < 0 || index >= expectedRefs.length) throw new Error(`${portalId} output has an unexpected input row number.`);
  return expectedRefs[index];
}

function detailStatus(row: Detail): { status: ServiceRowStatus; reason: string } {
  const fields = ["bot_overall_result", "Bot Status", "BotStatus", "result", "Result", "bot_status", "status", "Status"];
  const raw = fields.map((field) => row[field]).find(Boolean) ?? "";
  const note = ["bot_notes", "Bot Message", "BotStatusError", "notes", "Remarks", "error_message", "final_status", "Final Status"]
    .map((field) => row[field]).find(Boolean) ?? "";
  const combined = `${raw} ${note}`;
  if (ACTION.test(combined)) return { status: "ACTION_REQUIRED", reason: note || raw };
  if (NO_MATCH.test(combined)) return { status: "NO_MATCH", reason: note || raw };
  if (FAILURE.test(raw) || (!raw && FAILURE.test(note))) return { status: "FAILED", reason: note || raw };
  if (raw || note || row["Claim Status - Final Status"] || row["Claim Status"] || row.BotClaimStatus) {
    return { status: "SUCCESS", reason: "" };
  }
  return { status: "INCOMPLETE", reason: "" };
}

function normalizedClaim(ref: string, rows: Detail[], errors: Detail[]): ServiceRowResult {
  if (!rows.length && !errors.length) return {
    client_row_ref: ref, status: "INCOMPLETE", result: { claim_status: "", claim_details: "" },
    error_category: "INCOMPLETE", error_message: null,
  };
  const outcomes = rows.map(detailStatus);
  const errorMessages = errors.flatMap((row) => Object.entries(row)
    .filter(([key]) => /error|reason|message|description/i.test(key)).map(([, value]) => value)).filter(Boolean);
  const status: ServiceRowStatus = outcomes.some((item) => item.status === "ACTION_REQUIRED") ? "ACTION_REQUIRED"
    : errorMessages.length || outcomes.some((item) => item.status === "FAILED") ? "FAILED"
      : outcomes.some((item) => item.status === "INCOMPLETE") ? "INCOMPLETE"
        : outcomes.length && outcomes.every((item) => item.status === "NO_MATCH") ? "NO_MATCH"
          : outcomes.length ? "SUCCESS" : "FAILED";
  const details = [...new Set(rows.map((row) => row["Claim Status - Final Status"] || row.final_status || row["Final Status"] || row["Claim Status"] || row.BotClaimStatus || "").filter(Boolean))];
  const claimStatuses = [...new Set(rows.map((row) => row["Claim Status"] || row.BotClaimStatus || row.claim_outcome || row.status || "").filter(Boolean))];
  const message = [...new Set([...outcomes.map((item) => item.reason), ...errorMessages].filter(Boolean))].join(" | ");
  return {
    client_row_ref: ref,
    status,
    result: { claim_status: claimStatuses.join("; "), claim_details: details.join("\n\n"), detail_rows: rows },
    error_category: status === "SUCCESS" ? null : status === "ACTION_REQUIRED" ? "MANUAL_ACTION_REQUIRED" : status,
    error_message: status === "SUCCESS" ? null : message || null,
  };
}

export async function normalizeGenericClaimStatusWorkbook(
  bytes: Uint8Array, expectedRefs: string[], portalId: GenericClaimStatusServicePortalId,
): Promise<ServiceResultSummary> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const output = book.getWorksheet("Output") ?? (portalId === "uhc" ? book.worksheets[0] : undefined);
  if (!output) throw new Error(`${portalId} output workbook is missing the Output worksheet.`);
  const grouped = new Map<string, Detail[]>();
  const errors = new Map<string, Detail[]>();
  let waystarRef: string | null = null;
  for (const row of sheetRows(output)) {
    const directRef = sourceRef(row, expectedRefs, portalId);
    if (portalId === "waystar" && directRef) waystarRef = directRef;
    const ref = directRef ?? (portalId === "waystar" ? waystarRef : null);
    if (ref) grouped.set(ref, [...(grouped.get(ref) ?? []), row]);
  }
  for (const name of ["Error", "Error Log"]) {
    for (const row of sheetRows(book.getWorksheet(name))) {
      const ref = sourceRef(row, expectedRefs, portalId);
      if (ref) errors.set(ref, [...(errors.get(ref) ?? []), row]);
    }
  }
  const rowResults = expectedRefs.map((ref) => normalizedClaim(ref, grouped.get(ref) ?? [], errors.get(ref) ?? []));
  const firstIncomplete = rowResults.findIndex((item) => item.status === "INCOMPLETE");
  const counts = {
    total: rowResults.length,
    success: rowResults.filter((item) => item.status === "SUCCESS").length,
    no_match: rowResults.filter((item) => item.status === "NO_MATCH").length,
    failed: rowResults.filter((item) => item.status === "FAILED").length,
    action_required: rowResults.filter((item) => item.status === "ACTION_REQUIRED").length,
    incomplete: rowResults.filter((item) => item.status === "INCOMPLETE").length,
  };
  return {
    outcome: counts.success === counts.total ? "SUCCESS" : counts.success > 0 ? "PARTIAL_SUCCESS" : "FAILED",
    counts,
    row_results: rowResults,
    finalized_count: firstIncomplete < 0 ? rowResults.length : firstIncomplete,
  };
}

let s3Client: S3Client | undefined;
export async function loadGenericClaimStatusSnapshot(
  portalId: GenericClaimStatusServicePortalId, job: ServiceJob,
): Promise<{ expectedRefs: string[]; summary: ServiceResultSummary | null; artifact: ServiceWorkbookArtifact | null; recorded: boolean }> {
  const [expectedRefs, artifacts] = await Promise.all([loadServiceExpectedRefs(job), listArtifactsForJob(job.jobId)]);
  const output = artifacts.find((item) =>
    (item.artifactType === "output_snapshot" || item.artifactType === "file_download")
    && item.bucket && item.s3Key && item.filename.toLowerCase().endsWith(".xlsx"));
  if (!output?.bucket || !output.s3Key) return { expectedRefs, summary: null, artifact: null, recorded: false };
  s3Client ??= new S3Client({});
  const object = await s3Client.send(new GetObjectCommand({ Bucket: output.bucket, Key: output.s3Key }));
  if (!object.Body) throw new Error(`${portalId} output workbook is empty.`);
  const bytes = await object.Body.transformToByteArray();
  if (!bytes.length) throw new Error(`${portalId} output workbook is empty.`);
  return {
    expectedRefs,
    summary: await normalizeGenericClaimStatusWorkbook(bytes, expectedRefs, portalId),
    artifact: {
      bucket: output.bucket, object_key: output.s3Key, artifact_type: "output_snapshot", filename: output.filename,
      size_bytes: object.ContentLength ?? bytes.length, etag: object.ETag ?? null,
    },
    recorded: output.artifactType === "output_snapshot",
  };
}
