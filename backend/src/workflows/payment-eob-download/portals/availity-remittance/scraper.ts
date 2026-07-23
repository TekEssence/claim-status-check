import type { AutomationRunner } from "../../../types";
import type { PaymentEobRunInput } from "../../types";
import { availityRemittanceConfig } from "./config";
import { readAvailityRemittanceCredentials, readReferenceRows } from "./input";
import { runAvailityRemittanceJob } from "./remittance";

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

export function createAvailityRemittanceRunner(): AutomationRunner<PaymentEobRunInput> {
  return {
    workflowId: "payment-eob-download",
    portalId: availityRemittanceConfig.id,
    name: availityRemittanceConfig.name,
    validateInput(input) {
      if (!(input instanceof FormData)) {
        throw new Error("Payment EOB input must be multipart form data.");
      }
      return {
        credentialExcel: requireFile(input, "credentialExcel", "Credential Excel"),
        referenceExcel: requireFile(input, "referenceExcel", "Reference Excel"),
      };
    },
    async run(input, context) {
      const credentials = await readAvailityRemittanceCredentials(input.credentialExcel);
      const referenceRows = await readReferenceRows(input.referenceExcel);
      await context.log({
        level: "info",
        message: `Payment EOB input validation completed for ${input.credentialExcel.name || "credential workbook"} and ${input.referenceExcel.name || "reference workbook"}. ${referenceRows.length} reference row(s) loaded.`,
        eventName: "payment_eob_validation_complete",
      });
      await runAvailityRemittanceJob({ credentials, referenceRows }, context);
    },
  };
}
