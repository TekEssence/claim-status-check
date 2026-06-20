import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { getJobDataPath } from "./storage";

export async function saveScreenshotForJob(options: {
  jobId: string;
  page: Page;
  filename: string;
  quality?: number;
}): Promise<string> {
  const targetPath = path.join(getJobDataPath(options.jobId, "screenshots"), options.filename);
  const image = await options.page.screenshot({ type: "jpeg", quality: options.quality ?? 60 });
  fs.writeFileSync(targetPath, image);
  return targetPath;
}
