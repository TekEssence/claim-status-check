import * as XLSX from "xlsx";
import type { AstronaClaimDetails, AstronaInputRow, AstronaServiceLine } from "./types";

function amount(value: string): number | null {
  const normalized = value.replace(/[$,\s]/g, "").replace(/[()]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return value.includes("(") ? -parsed : parsed;
}

export function astronaFinalStatus(netAmount: string): "Paid" | "Denied" | "Unknown" {
  const parsed = amount(netAmount);
  if (parsed == null) return "Unknown";
  return parsed === 0 ? "Denied" : "Paid";
}

export function astronaFinalStatusText(row: AstronaInputRow, details: AstronaClaimDetails, serviceLine: AstronaServiceLine): string {
  const net = serviceLine.net || details.netAmount;
  const outcome = astronaFinalStatus(net);
  const dos = row.dos || serviceLine.from || serviceLine.to;
  const received = details.dateReceived || "";
  const claimNumber = details.claimNumber || "";
  if (outcome === "Paid") {
    return `DOS ${dos}: Checked Astrona portal claim received on ${received} paid on ${details.datePaid || ""} paid amount ${net} EFT/Check # ${details.checkNumber || ""}. Claim # ${claimNumber}.`;
  }
  if (outcome === "Denied") {
    const denialReason = serviceLine.memoLine1 || details.memoLine1 || details.portalStatus || "";
    return `DOS ${dos}: Checked Astrona portal claim received on ${received} denied on ${details.dateDenied || details.datePaid || ""} denial reason ${denialReason}. Claim# ${claimNumber}.`;
  }
  return `DOS ${dos}: Checked Astrona portal claim status ${details.portalStatus || "Unknown"}. Claim# ${claimNumber}.`;
}

function emptyServiceLine(): AstronaServiceLine {
  return { from: "", to: "", cpt: "", modifier: "", diagCode: "", qty: "", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "", memoLine1: "" };
}

export function astronaOutputRows(row: AstronaInputRow, details: AstronaClaimDetails, result = "success", notes = "") {
  const serviceLines = details.serviceLines.length ? details.serviceLines : [emptyServiceLine()];
  return serviceLines.map((serviceLine, index) => {
    const net = serviceLine.net || details.netAmount;
    const memoLine1 = serviceLine.memoLine1 || details.memoLine1;
    return {
    input_row_id: row.inputRowId,
    group: row.group,
    payer: row.payer,
    responsible_payer: row.payer,
    member_id: row.memberId,
    member_name: row.memberName,
    input_dob: row.dob,
    input_dos: row.dos,
    input_cpt: row.cptCode,
    claim_number: details.claimNumber,
    date_paid: details.datePaid,
    check_number: details.checkNumber,
    portal_status: details.portalStatus,
    service_line_number: details.serviceLines.length ? index + 1 : "",
    from: serviceLine.from,
    to: serviceLine.to,
    cpt: serviceLine.cpt,
    modifier: serviceLine.modifier,
    diag_code: serviceLine.diagCode,
    qty: serviceLine.qty,
    billed: serviceLine.billed,
    co_pay: serviceLine.coPay,
    co_insure: serviceLine.coInsure,
    deductible: serviceLine.deductible,
    adjustment: serviceLine.adjustment,
    net,
    net_amount: net,
    services_cpt: details.cptCodes.join("; "),
    memo_line_1: memoLine1,
    claim_outcome: astronaFinalStatus(net),
    final_status: result === "success" ? astronaFinalStatusText(row, details, serviceLine) : (notes || "No data found in portal."),
    result,
    notes,
    extracted_at: new Date().toISOString(),
    };
  });
}

export function astronaOutputRow(row: AstronaInputRow, details: AstronaClaimDetails, result = "success", notes = "") {
  return astronaOutputRows(row, details, result, notes)[0];
}

export function createAstronaWorkbook(outputRows: Record<string, unknown>[], errorRows: Record<string, unknown>[], auditRows: Record<string, unknown>[]): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(outputRows), "Output");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(errorRows), "Error");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(auditRows), "Audit_Log");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
