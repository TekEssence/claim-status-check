import type { AvailityEligibilityPayerHandler } from "../types";
import { runBcbsAvailityEligibilityWorkflow } from "./workflow";

export const bcbsAvailityEligibilityPayer: AvailityEligibilityPayerHandler = {
  id: "bcbs",
  name: "Blue Cross Blue Shield",
  run: runBcbsAvailityEligibilityWorkflow,
};
