import type { AutomationRunner } from "../../../types";
import type { EligibilityRunInput } from "../../types";
import { readWaystarEligibilityWorkbook } from "./input";

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

export function createWaystarRunner(): AutomationRunner<EligibilityRunInput> {
  return {
    workflowId: "eligibility-verification",
    portalId: "waystar",
    name: "Waystar Eligibility Verification",
    validateInput(input) {
      if (!(input instanceof FormData)) {
        throw new Error("Waystar eligibility input must be multipart form data.");
      }
      return {
        inputFile: requireFile(input, "inputFile", "Eligibility input file"),
        credentialFile: requireFile(input, "credentialFile", "Credential file"),
      };
    },
    async run(input, context) {
      const routing = await readWaystarEligibilityWorkbook(input.inputFile);
      await context.emit({
        type: "progress",
        completed: 0,
        total: routing.totalRows,
      });
      await context.log({
        level: "info",
        message: `Detected payer column "${routing.payerHeader}" with ${routing.totalRows} rows.`,
        eventName: "eligibility_started",
      });

      for (const batch of routing.batches) {
        await context.log({
          level: "info",
          message: `Routed ${batch.rows.length} row(s) to ${batch.payerName}.`,
          eventName: "eligibility_payer_batch",
          meta: { payerId: batch.payerId, rowCount: batch.rows.length },
        });
      }

      if (routing.unsupportedRows.length > 0) {
        await context.log({
          level: "warn",
          message: `${routing.unsupportedRows.length} row(s) have an empty or unsupported insurance name.`,
          eventName: "eligibility_unsupported_payer",
          meta: { rows: routing.unsupportedRows },
        });
      }

      if (routing.batches.length === 0) {
        throw new Error("No supported Waystar payer rows were found in the workbook.");
      }

      throw new Error(
        "Waystar browser selectors and payer processing flows are not configured yet.",
      );
    },
  };
}
