import fs from "node:fs/promises";
import path from "node:path";
import { regalWritableDataPath } from "./storage";

export type RegalLogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error";
  stage: string;
  message: string;
  url?: string;
};

export function formatRegalLog(entries: RegalLogEntry[]): string {
  const lines = ["Regal scraper latest run log", ""];
  for (const entry of entries) {
    lines.push([
      entry.timestamp,
      entry.level.toUpperCase(),
      entry.stage,
      entry.message,
      entry.url ? `url=${entry.url}` : "",
    ].filter(Boolean).join(" | "));
  }
  return `${lines.join("\n")}\n`;
}

export async function saveRegalLatestLog(content: string): Promise<string> {
  const dir = regalWritableDataPath("logs", "regal");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "regal-latest.log");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}
