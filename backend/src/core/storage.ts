import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureDirectory(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function getWorkflowRuntimeBaseDir(): string {
  return process.env.SCRAPE_DATA_DIR ||
    process.env.DATA_DIR ||
    process.env.CLAIM_STATUS_RUNTIME_DIR ||
    (process.env.NODE_ENV === "production" || process.env.VERCEL || process.env.LAMBDA_TASK_ROOT
      ? path.join(os.tmpdir(), "claim-status-artifacts")
      : path.join(process.cwd(), "data"));
}

export function getWorkflowRuntimePath(...segments: string[]): string {
  return ensureDirectory(path.join(getWorkflowRuntimeBaseDir(), ...segments));
}

export function getJobDataPath(jobId: string, area: "outputs" | "screenshots" | "downloads" | "logs" | "jobs"): string {
  return getWorkflowRuntimePath(area, jobId);
}
