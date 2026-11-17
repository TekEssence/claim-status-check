import ExcelJS from "exceljs";
import type { PreparedClaim } from "./iehp-input";

/**
 * Encode the JSON transport as a workbook, without portal rules. Both manual
 * workbooks and these generated workbooks enter the same worker input parser.
 * Its flat, header-keyed rows are the existing canonical claim representation;
 * aliases, defaults, preprocessing and row validation belong to that pipeline.
 */
export async function encodeServiceClaimWorkbook(claims: PreparedClaim[]) {
  const rows = claims.map((claim, index) => ({
    ...claim.data, "Client Row Ref": claim.client_row_ref, __original_index: index,
  }));
  const headers = ["Client Row Ref", ...new Set(claims.flatMap(claim => Object.keys(claim.data)))];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Claims");
  sheet.addRow(headers);
  // A missing cell must stay absent. Writing an empty string for another row's
  // header can shadow a populated alias in readers using nullish fallback
  // (for example IEHP's Date Of Service ?? DOS or Member Policy ID ?? Member ID).
  for (const row of rows) sheet.addRow(headers.map(header => (row as PreparedClaim["data"])[header] ?? null));
  return { rows, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
}
