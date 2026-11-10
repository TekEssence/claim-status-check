import type { GenericClaimStatusServicePortalId } from "./generic-claim-status-input";

export type NativeClaimRow = Record<string, unknown>;

export function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** Use the manual runner's readers, aliases and row validation for service inputs. */
export async function readServicePortalClaims(portal: GenericClaimStatusServicePortalId, buffer: Buffer): Promise<NativeClaimRow[]> {
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
      if (parsed.invalidRows.length) throw new Error(parsed.invalidRows[0].error);
      rows = parsed.claimRows as unknown as NativeClaimRow[];
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
  if (!rows.length) throw new Error(`${portal} input contains no claims to process.`);
  const invalid = rows.find(row => row.validationStatus === "invalid" || row.validation_status === "invalid");
  if (invalid) throw new Error(`${portal} claim ${invalid.inputRowId ?? invalid.input_row_id}: ${invalid.validationMessage ?? invalid.validation_message}`);
  return rows;
}

export async function validateServicePortalCredentials(
  portal: GenericClaimStatusServicePortalId, rows: NativeClaimRow[], login: Buffer, form: FormData,
): Promise<void> {
  const bytes = asArrayBuffer(login);
  let unmapped: unknown[] = [];
  switch (portal) {
    case "all-care": {
      const input = await import("../../workflows/claim-status/portals/all-care/input");
      unmapped = input.routeAllCareRows(rows as Parameters<typeof input.routeAllCareRows>[0], input.readAllCareCredentials(bytes)).unmappedRows;
      break;
    }
    case "astrona": {
      const input = await import("../../workflows/claim-status/portals/astrona/input");
      unmapped = input.routeAstronaRows(rows as Parameters<typeof input.routeAstronaRows>[0], input.readAstronaCredentials(bytes)).unmappedRows;
      break;
    }
    case "blue-shield": {
      const input = await import("../../workflows/claim-status/portals/blue-shield/input");
      unmapped = input.routeBlueShieldRowsByCredentials(rows as Parameters<typeof input.routeBlueShieldRowsByCredentials>[0], bytes).unmappedRows;
      break;
    }
    case "aerial": {
      const { resolveAerialSubportal } = await import("../../workflows/claim-status/portals/aerial/subportals/registry");
      const { loadCredentialsForAerialSubportal } = await import("../../workflows/claim-status/portals/aerial/common/credential-workbook");
      const subportal = resolveAerialSubportal(form.get("aerialSubportal"));
      const groups = [...new Set(rows.map(row => String(row.Group ?? "").trim()).filter(Boolean))];
      if (subportal.id === "citrus-valley" && !groups.length) throw new Error("Citrus Valley input claims must contain a Group column.");
      if ((groups.length ? groups : [""]).some(group => !loadCredentialsForAerialSubportal(bytes, subportal, group))) {
        throw new Error("No matching Aerial credential account for the submitted subportal and Group.");
      }
      break;
    }
    case "cigna": await (await import("../../workflows/claim-status/portals/cigna/input")).parseCignaInput(form); break;
    case "kaiser": await (await import("../../workflows/claim-status/portals/kaiser/input")).parseKaiserInput(form); break;
    case "my-family": await (await import("../../workflows/claim-status/portals/my_family/input")).parseMyFamilyInput(form); break;
    case "physicians": await (await import("../../workflows/claim-status/portals/physicians/input")).parsePhysiciansInput(form); break;
    case "regal": await (await import("../../workflows/claim-status/portals/regal/input")).parseRegalInput(form); break;
    case "medpoint": await (await import("../../workflows/claim-status/portals/medpoint/input")).parseMedpointInput(form); break;
    case "optum-pro": await (await import("../../scrapers/optum-pro/input")).parseOptumProInput(form); break;
    case "waystar": await (await import("../../workflows/claim-status/portals/waystar/input")).parseWaystarInput(form); break;
    case "uhc": await (await import("../../workflows/claim-status/portals/uhc/excel")).readLoginExcel(bytes); break;
  }
  if (unmapped.length) throw new Error(`Submitted claims have no matching ${portal} credential account.`);
}
