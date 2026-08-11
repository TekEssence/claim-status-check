import type { AvailityEligibilityPayerHandler } from "../types";
import { runHumanaAvailityEligibilityWorkflow } from "./workflow";

export const humanaAvailityEligibilityPayer: AvailityEligibilityPayerHandler = {
  id: "humana",
  name: "Humana",
  run: runHumanaAvailityEligibilityWorkflow,
};