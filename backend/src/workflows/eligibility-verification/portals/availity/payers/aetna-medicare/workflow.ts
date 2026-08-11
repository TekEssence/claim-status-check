import type { AvailityEligibilityPayerWorkflowInput } from "../types";
import { runBcbsAvailityEligibilityWorkflow } from "../bcbs/workflow";

export async function runAetnaMedicareAvailityEligibilityWorkflow(
  input: AvailityEligibilityPayerWorkflowInput,
): Promise<void> {
  await runBcbsAvailityEligibilityWorkflow(input, {
    payerSelection: "AETNA (COMMERCIAL & MEDICARE)",
    skipProviderType: true,
    skipPlaceOfService: true,
    ensureHealthBenefitPlanCoverage: true,
    useCoverageBenefitDatesFallback: true,
  });
}