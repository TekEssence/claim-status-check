import * as XLSX from "xlsx";
import type { AutomationContext } from "../types";
import type { EligibilityInputRow, EligibilityResult } from "./types";

type NativeEligibilityOutput = { inputFile: File; rows: Map<number, EligibilityInputRow>;
  results: Map<number, EligibilityResult>; errors: Map<number, string> };

/** Reuse each portal's native writer; only finalized rows enter service snapshots. */
export function createEligibilityServiceSnapshots(context: AutomationContext, input: NativeEligibilityOutput,
  build: (input: NativeEligibilityOutput) => Promise<Uint8Array>) {
  const publish = createEligibilityServiceSnapshotPublisher(context, () => {
    const rows = new Map([...input.rows].filter(([index]) => input.results.has(index) || input.errors.has(index)));
    return build({ ...input, rows });
  });
  return () => !input.results.size && !input.errors.size ? Promise.resolve() : publish();
}

/** UHC updates its workbook directly; map-based portals use the same throttle above. */
export function createEligibilityServiceSnapshotPublisher(context: AutomationContext, build: () => Promise<Uint8Array>) {
  let publishedAt = 0;
  return async () => {
    if (!context.saveServiceResults || Date.now() - publishedAt < 10_000) return;
    try {
      await context.saveServiceResults(await build());
      publishedAt = Date.now();
    } catch {
      // A storage outage must not become a portal/payer failure. The next
      // snapshot and the existing stop recovery can retry the saved outcomes.
      await context.log({ level: "warn", eventName: "eligibility_service_publication_retry",
        message: "Eligibility result publication failed; the next snapshot or stopped-task recovery will retry." });
    }
  };
}

type EligibilityRowEvent = {
  type?: unknown;
  rowIndex?: unknown;
  update?: unknown;
  completed?: unknown;
};

const MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function cellValue(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

export async function createEligibilityPartialOutput(inputFile: File, portalId: string) {
  const input = XLSX.read(await inputFile.arrayBuffer(), { type: "array", cellDates: true });
  const source = input.Sheets[input.SheetNames[0]];
  if (!source) throw new Error("Eligibility input workbook has no worksheet.");
  const inputRows = XLSX.utils.sheet_to_json<Array<string | number | boolean>>(source, {
    header: 1,
    defval: "",
    blankrows: true,
  });
  const updates = new Map<number, Record<string, unknown>>();
  let savedRows = 0;
  let lastSavedAt = 0;

  return {
    filename: `${portalId}-eligibility-partial-output.xlsx`,
    mimeType: MIME_TYPE,
    record(event: EligibilityRowEvent): boolean {
      if (typeof event.type === "string" && event.type.startsWith("eligibility_") && event.type.endsWith("_result")
        && Number.isInteger(event.rowIndex) && Number(event.rowIndex) >= 2
        && event.update && typeof event.update === "object" && !Array.isArray(event.update)) {
        updates.set(Number(event.rowIndex), event.update as Record<string, unknown>);
      }
      if (event.type !== "progress" || typeof event.completed !== "number") return false;
      return updates.size > savedRows && event.completed > 0 && (savedRows === 0 || Date.now() - lastSavedAt >= 10_000);
    },
    hasUnsavedRows(): boolean {
      return updates.size > savedRows;
    },
    build(): Buffer {
      const headers = Array.from(new Set(Array.from(updates.values()).flatMap((update) =>
        Object.keys(update).filter((key) => !key.startsWith("__"))))).sort();
      const resultRows: Array<Array<string | number | boolean>> = [["Excel Row", ...headers]];
      for (const [rowIndex, update] of [...updates].sort(([a], [b]) => a - b)) {
        resultRows.push([rowIndex, ...headers.map((header) => cellValue(update[header]))]);
      }
      const output = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(output, XLSX.utils.aoa_to_sheet(inputRows), "Input");
      XLSX.utils.book_append_sheet(output, XLSX.utils.aoa_to_sheet(resultRows), "Partial Results");
      return XLSX.write(output, { type: "buffer", bookType: "xlsx" }) as Buffer;
    },
    markSaved(): void {
      savedRows = updates.size;
      lastSavedAt = Date.now();
    },
  };
}
