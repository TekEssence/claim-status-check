import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { getJobDataPath } from "@/backend/src/core/storage";

type StreamEvent = Record<string, unknown>;

function safeArtifactName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
}

export async function captureRowDiagnostics(options: {
  jobId: string;
  page: Page;
  rowIndex: number;
  rowNumber: number;
  reason: string;
  sendEvent: (data: StreamEvent) => Promise<void>;
  log: (message: string) => Promise<void>;
}): Promise<void> {
  const { jobId, page, rowIndex, rowNumber, reason, sendEvent, log } = options;
  const artifactDir = getJobDataPath(jobId, "screenshots");
  const baseName = safeArtifactName(`row-${rowNumber}-${reason}-${Date.now()}`);

  try {
    const screenshot = await page.screenshot({ type: "jpeg", quality: 60 });
    const screenshotPath = path.join(artifactDir, `${baseName}.jpg`);
    fs.writeFileSync(screenshotPath, screenshot);
    await sendEvent({
      type: "error_screenshot",
      index: rowIndex,
      image: screenshot.toString("base64"),
      path: screenshotPath,
    });

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const htmlPath = path.join(artifactDir, `${baseName}.html`);
    fs.writeFileSync(htmlPath, html, "utf8");
    await sendEvent({ type: "debug_html", index: rowIndex, html, path: htmlPath });
    await log(`Row ${rowNumber}: Saved diagnostics to ${artifactDir}.`);
  } catch {
    await log(`Row ${rowNumber}: Failed to capture row error diagnostics.`);
  }
}

export function isRaDetailNoMatchMessage(message: string): boolean {
  return /No matching (?:Claim|Covered) RA detail line found in PDF/i.test(message);
}

export function isMainClaimSearchMessage(message: string): boolean {
  return /No matching claim rows on website/i.test(message);
}
