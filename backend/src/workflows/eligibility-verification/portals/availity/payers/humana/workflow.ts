import type { AvailityEligibilityPayerWorkflowInput } from "../types";
import { runBcbsAvailityEligibilityWorkflow } from "../bcbs/workflow";

export async function runHumanaAvailityEligibilityWorkflow(
  input: AvailityEligibilityPayerWorkflowInput,
): Promise<void> {
  await runBcbsAvailityEligibilityWorkflow(input, {
    payerSelection: "Humana",
    skipProviderType: true,
    skipPlaceOfService: true,
    usePlanBeginDateFallback: true,
  });
}