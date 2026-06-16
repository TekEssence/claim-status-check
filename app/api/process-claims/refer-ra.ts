import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { formatMmDdYyyy } from "@/lib/claim-dates";
import { extractTextFromPdf, extractTextPagesFromPdf } from "@/lib/claim-pdf";
import { parseRaDetailsFromPdfPages, parseRaDetailsFromText, type RaDetailRecord } from "@/lib/claim-ra";
import { downloadCoveredRaPdf, navigateToCoveredRaPage, searchCoveredRaByCheckNumber } from "./covered-ra";

type StreamEvent = Record<string, unknown>;

type ReferRaOptions = {
  page: Page;
  rowNumber: number;
  rowIndex: number;
  memberPolicyId: string;
  dosDate: Date;
  cpt: string;
  checkNumbers: string[];
  log: (message: string) => Promise<void>;
  sendEvent: (data: StreamEvent) => Promise<void>;
};

export async function processReferToRaDownloads({
  page,
  rowNumber,
  rowIndex,
  memberPolicyId,
  dosDate,
  cpt,
  checkNumbers,
  log,
  sendEvent,
}: ReferRaOptions): Promise<RaDetailRecord[]> {
  const referRaDetails: RaDetailRecord[] = [];
  const uniqueChecks = Array.from(new Set(checkNumbers));

  if (uniqueChecks.length === 0) {
    return referRaDetails;
  }

  await log(`Row ${rowNumber}: Downloading RAs sequentially for Check Numbers: ${uniqueChecks.join(", ")}`);

  await navigateToCoveredRaPage(page, log);

  for (let cIdx = 0; cIdx < uniqueChecks.length; cIdx++) {
    const chk = uniqueChecks[cIdx];
    await log(`Row ${rowNumber}: Processing RA for Check Number ${chk} (${cIdx + 1}/${uniqueChecks.length})...`);

    await searchCoveredRaByCheckNumber(page, chk, log);
    const download = await downloadCoveredRaPdf(page, chk, log);

    const downloadsDir = path.join(os.tmpdir(), "downloads");
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
    const cleanDos = formatMmDdYyyy(dosDate).replace(/\//g, "-");
    const pdfFileName = `${rowIndex + 2}_${memberPolicyId}_${cleanDos}_${chk}.pdf`;
    const pdfPath = path.join(downloadsDir, pdfFileName);
    await download.saveAs(pdfPath);

    try {
      const pdfBuffer = fs.readFileSync(pdfPath);
      await sendEvent({ type: "pdf_download", filename: pdfFileName, base64: pdfBuffer.toString("base64") });

      const pdfText = await extractTextFromPdf(pdfBuffer);
      const pdfPages = await extractTextPagesFromPdf(pdfBuffer);
      const parsedRecords = parseRaDetailsFromPdfPages({
        pages: pdfPages,
        memberPolicyId,
        dosDate,
        cpt,
        checkNumber: chk,
      });

      if (parsedRecords.length > 0) {
        referRaDetails.push(...parsedRecords);
      } else {
        const fallbackRecords = parseRaDetailsFromText({
          text: pdfText,
          memberPolicyId,
          dosDate,
          cpt,
          checkNumber: chk,
        });

        if (fallbackRecords.length > 0) {
          referRaDetails.push(...fallbackRecords);
        } else {
          throw new Error(`No matching RA detail line found in PDF for Check ${chk}, CPT ${cpt}, DOS ${formatMmDdYyyy(dosDate)}.`);
        }
      }
    } finally {
      try {
        fs.unlinkSync(pdfPath);
      } catch {
        await log(`Row ${rowNumber}: Warning: Could not delete temporary PDF ${pdfFileName}.`);
      }
    }
  }

  return referRaDetails;
}
