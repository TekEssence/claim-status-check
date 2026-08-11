import type { AvailityEligibilityPayerWorkflowInput } from "../types";
import { runBcbsAvailityEligibilityWorkflow } from "../bcbs/workflow";

export async function runWellcareAvailityEligibilityWorkflow(
  input: AvailityEligibilityPayerWorkflowInput,
): Promise<void> {
  await runBcbsAvailityEligibilityWorkflow(input, {
    payerSelection: "Wellcare",
    skipProviderType: true,
    skipPlaceOfService: true,
    ensureHealthBenefitPlanCoverage: true,
    requirePatientName: true,
    useWellcareEligibilityFallbacks: true,
  });
}