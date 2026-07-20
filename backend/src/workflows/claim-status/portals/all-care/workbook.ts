import * as XLSX from "xlsx";
import type { AllCareClaimDetails, AllCareInputRow, AllCareServiceLine } from "./types";

function amount(value: string): number | null {
  const normalized = value.replace(/[$,\s]/g, "").replace(/[()]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return value.includes("(") ? -parsed : parsed;
}

export function allCareFinalStatus(netAmount: string): "Paid" | "Denied" | "Unknown" {
  const parsed = amount(netAmount);
  if (parsed == null) return "Unknown";
  return parsed === 0 ? "Denied" : "Paid";
}

export function allCareFinalStatusText(row: AllCareInputRow, details: AllCareClaimDetails, serviceLine: AllCareServiceLine): string {
  const net = serviceLine.net || details.netAmount;
  const outcome = allCareFinalStatus(net);
  const dos = row.dos || serviceLine.from || serviceLine.to;
  const received = details.dateReceived || "";
  const claimNumber = details.claimNumber || "";
  if (outcome === "Paid") {
    return `DOS ${dos}: Checked All Care portal claim received on ${received} paid on ${details.datePaid || ""} paid amount ${net} EFT/Check # ${details.checkNumber || ""}. Claim # ${claimNumber}.`;
  }
  if (outcome === "Denied") {
    const denialReason = [serviceLine.carc, serviceLine.rarc].filter(Boolean).join(" / ")
      || serviceLine.memoLine1 || details.memoLine1 || details.portalStatus || "";
    return `DOS ${dos}: Checked All Care portal claim received on ${received} denied on ${details.dateDenied || details.datePaid || ""} denial reason ${denialReason}. Claim# ${claimNumber}.`;
  }
  return `DOS ${dos}: Checked All Care portal claim status ${details.portalStatus || "Unknown"}. Claim# ${claimNumber}.`;
}

function emptyServiceLine(): AllCareServiceLine {
  return { claim: "", vendorName: "", dateReceived: "", dateFinalized: "", check: "", checkAmount: "", from: "", to: "", cpt: "", modifier: "", diagCode: "", qty: "", billed: "", allowed: "", coPay: "", coInsure: "", deductible: "", seq: "", adjustment: "", withhold: "", interest: "", net: "", carc: "", rarc: "", memoLine1: "" };
}

export function allCareOutputRows(row: AllCareInputRow, details: AllCareClaimDetails, result = "success", notes = "") {
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
    Claim: serviceLine.claim || details.claimNumber,
    "Vendor Name": serviceLine.vendorName || details.vendorName || "",
    "Date Rcvd": serviceLine.dateReceived || details.dateReceived || "",
    "Date Finalized": serviceLine.dateFinalized || details.datePaid || details.dateDenied || "",
    Check: serviceLine.check || details.checkNumber,
    "Check Amount": serviceLine.checkAmount || details.checkAmount || "",
    Proc: serviceLine.cpt,
    Mod: serviceLine.modifier,
    Billed: serviceLine.billed,
    Allowed: serviceLine.allowed,
    Copay: serviceLine.coPay,
    Coins: serviceLine.coInsure,
    Deductible: serviceLine.deductible,
    SEQ: serviceLine.seq,
    Adjust: serviceLine.adjustment,
    Withhold: serviceLine.withhold,
    Interest: serviceLine.interest,
    NetPay: net,
    CARC: serviceLine.carc,
    RARC: serviceLine.rarc,
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
    claim_outcome: allCareFinalStatus(net),
    final_status: result === "success" ? allCareFinalStatusText(row, details, serviceLine) : (notes || "No data found in portal."),
    result,
    notes,
    extracted_at: new Date().toISOString(),
    };
  });
}

export function allCareOutputRow(row: AllCareInputRow, details: AllCareClaimDetails, result = "success", notes = "") {
  return allCareOutputRows(row, details, result, notes)[0];
}

export function createAllCareWorkbook(outputRows: Record<string, unknown>[], errorRows: Record<string, unknown>[], auditRows: Record<string, unknown>[]): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(outputRows), "Output");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(errorRows), "Error");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(auditRows), "Audit_Log");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
