import type { GenericClaimStatusServicePortalId } from "./generic-claim-status-input";

export type NativeClaimRow = Record<string, unknown>;

export function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** Test projection of native worker readers. Never imported by HTTP ingestion. */
export async function readPortalClaimRows(portal: GenericClaimStatusServicePortalId, buffer: Buffer): Promise<NativeClaimRow[]> {
  const bytes = asArrayBuffer(buffer);
  let rows: NativeClaimRow[];
  switch (portal) {
    case "aerial": rows = (await import("../../workflows/claim-status/portals/aerial/workbook")).readAerialInputWorkbookFromBuffer(bytes); break;
    case "all-care": rows = (await import("../../workflows/claim-status/portals/all-care/input")).readAllCareInputRows(bytes); break;
    case "astrona": rows = (await import("../../workflows/claim-status/portals/astrona/input")).readAstronaInputRows(bytes); break;
    case "blue-shield": rows = (await import("../../workflows/claim-status/portals/blue-shield/input")).readBlueShieldInputWorkbook(bytes); break;
    case "cigna": rows = (await import("../../workflows/claim-status/portals/cigna/input")).readCignaInputWorkbook(bytes); break;
    case "kaiser": rows = (await import("../../workflows/claim-status/portals/kaiser/input")).readKaiserInputWorkbook(bytes); break;
    case "my-family": rows = (await import("../../workflows/claim-status/portals/my_family/input")).readMyFamilyInputWorkbook(bytes); break;
    case "physicians": rows = (await import("../../workflows/claim-status/portals/physicians/input")).readPhysiciansInputWorkbook(bytes); break;
    case "regal": rows = (await import("../../workflows/claim-status/portals/regal/input")).readRegalClaimRowsFromBuffer(bytes); break;
    case "medpoint": rows = (await import("../../workflows/claim-status/portals/medpoint/input")).readMedpointInputRowsFromBuffer(bytes) as unknown as NativeClaimRow[]; break;
    case "optum-pro": rows = (await import("../../scrapers/optum-pro/input")).readOptumProInputRowsFromBuffer(bytes) as unknown as NativeClaimRow[]; break;
    case "waystar": {
      const parsed = await (await import("../../workflows/claim-status/portals/waystar/input"))
        .parseWaystarClaimWorkbook(new File([new Uint8Array(buffer)], "claims.xlsx"));
      rows = [...parsed.claimRows, ...parsed.invalidRows].sort((a, b) => a.inputRowId - b.inputRowId) as unknown as NativeClaimRow[];
      break;
    }
    case "uhc": {
      const ExcelJS = (await import("exceljs")).default;
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(bytes);
      if (!book.worksheets[0]) throw new Error("UHC claim workbook does not contain a worksheet.");
      rows = (await import("../../workflows/claim-status/portals/uhc/workbook-output")).parseUhcClaimRows(book.worksheets[0]);
      break;
    }
  }
  return rows;
}
