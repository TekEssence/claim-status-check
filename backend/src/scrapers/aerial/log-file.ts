import fs from "node:fs/promises";
import path from "node:path";

export function formatAerialLog(auditRows: Record<string, unknown>[], errorRows: Record<string, unknown>[]): string {
  const lines = ["Aerial scraper run log", ""];

  lines.push("Audit");
  for (const row of auditRows) {
    lines.push([
      row.timestamp,
      row.input_row_id ? `row=${row.input_row_id}` : "",
      row.step,
      row.status,
      row.message,
      row.current_url,
    ].filter(Boolean).join(" | "));
  }

  lines.push("", "Errors");
  for (const row of errorRows) {
    lines.push([
      row.timestamp,
      row.input_row_id ? `row=${row.input_row_id}` : "",
      row.failure_stage,
      row.failure_reason,
      row.human_message,
      row.snapshot_path,
    ].filter(Boolean).join(" | "));
  }

  return `${lines.join("\n")}\n`;
}

export async function saveAerialLogFile(jobId: string, content: string): Promise<string> {
  const dir = path.join(process.cwd(), "data", "logs", "aerial", jobId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "aerial-run.log");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}
