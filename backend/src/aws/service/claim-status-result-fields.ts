import { CLAIM_STATUS_OUTPUT_HEADERS, claimStatusOutputValues } from "../../workflows/claim-status/output-columns";
import type { ServiceRowResult } from "./service-contract";

/** Stable five-column contract for every Claim Status portal and project. */
export function claimStatusResultFields(portal: string, result: ServiceRowResult["result"]): ServiceRowResult["result"] {
  const detailRows = (result.detail_rows ?? []).map(row => ({ ...row, ...claimStatusOutputValues(portal, row) }));
  const fields = claimStatusOutputValues(portal, {});
  for (const header of CLAIM_STATUS_OUTPUT_HEADERS) {
    // Detail rows can represent separate claims, checks or service lines. Do not
    // guess a sum or select one when the workbook has conflicting values.
    const values = detailRows.map(row => row[header]);
    const first = values[0];
    fields[header] = first != null && values.every(value => value !== null && String(value) === String(first)) ? first : null;
  }
  return { ...result, ...fields, detail_rows: detailRows };
}
