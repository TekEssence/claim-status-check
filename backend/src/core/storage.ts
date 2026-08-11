import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureDirectory(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function getJobDataPath(jobId: string, area: "outputs" | "screenshots" | "downloads" | "logs" | "jobs"): string {
  const baseDir = process.env.SCRAPE_DATA_DIR ||
    process.env.DATA_DIR ||
    (process.env.VERCEL || process.env.LAMBDA_TASK_ROOT ? path.join(os.tmpdir(), "iehp-claim-status-check") : path.join(process.cwd(), "data"));
  return ensureDirectory(path.join(baseDir, area, jobId));
}
