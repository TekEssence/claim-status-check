import fs from "node:fs";
import path from "node:path";
import type { Download } from "playwright-core";
import { getJobDataPath } from "./storage";

export async function saveDownloadForJob(options: {
  jobId: string;
  download: Download;
  filename: string;
}): Promise<string> {
  const targetPath = path.join(getJobDataPath(options.jobId, "downloads"), options.filename);
  await options.download.saveAs(targetPath);
  return targetPath;
}

export function readDownloadAsBase64(filePath: string): string {
  return fs.readFileSync(filePath).toString("base64");
}
