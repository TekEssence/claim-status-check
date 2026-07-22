import type { AutomationRunner } from "../../../types";
import type { PaymentEobRunInput } from "../../types";
import { availityRemittanceConfig } from "./config";

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
      await context.log({
        level: "info",
        message: `Payment EOB input validation completed for ${input.credentialExcel.name || "credential workbook"} and ${input.referenceExcel.name || "reference workbook"}.`,
        eventName: "payment_eob_validation_complete",
      });
      await context.emit({ type: "progress", completed: 1, total: 1 });
      await context.log({
        level: "info",
        message: "Payment EOB workflow shell is ready. Portal automation is not implemented yet.",
        eventName: "payment_eob_shell_ready",
      });
    },
  };
}

