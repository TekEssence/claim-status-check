import type { ScraperContext } from "./types";

const WORKBOOK_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Persist the current portal workbook without interrupting claim processing if a snapshot fails. */
export async function emitPartialOutputSnapshot(
  context: ScraperContext,
  filename: string,
  workbook: Buffer | (() => Buffer | Promise<Buffer>),
  completed: number,
  total: number,
): Promise<void> {
  if (completed < 1) return;
  try {
    const buffer = typeof workbook === "function" ? await workbook() : workbook;
    await context.emit({
      type: "output_snapshot",
      filename,
      base64: buffer.toString("base64"),
      mimeType: WORKBOOK_MIME,
      completed,
      total,
    });
  } catch (error) {
    await context.log({
      level: "warn",
      message: `Could not save ${filename} partial output after ${completed}/${total} rows: ${error instanceof Error ? error.message : String(error)}`,
    }).catch(() => {});
  }
}
