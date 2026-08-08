import type { AvailityEligibilityPayerHandler } from "../types";
import { runAetnaMedicareAvailityEligibilityWorkflow } from "./workflow";

export const aetnaMedicareAvailityEligibilityPayer: AvailityEligibilityPayerHandler = {
  id: "aetna-medicare",
  name: "Aetna Medicare",
  run: runAetnaMedicareAvailityEligibilityWorkflow,
};
