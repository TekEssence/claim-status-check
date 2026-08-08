import type { AvailityEligibilityPayerHandler } from "../types";
import { runWellcareAvailityEligibilityWorkflow } from "./workflow";

export const wellcareAvailityEligibilityPayer: AvailityEligibilityPayerHandler = {
  id: "wellcare",
  name: "Wellcare",
  run: runWellcareAvailityEligibilityWorkflow,
};