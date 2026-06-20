import fs from "node:fs";
import path from "node:path";

export function ensureDirectory(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function getJobDataPath(jobId: string, area: "outputs" | "screenshots" | "downloads" | "logs" | "jobs"): string {
  return ensureDirectory(path.join(process.cwd(), "data", area, jobId));
}
