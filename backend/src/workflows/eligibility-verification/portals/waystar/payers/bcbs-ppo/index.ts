import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const bcbsPpoPayer: WaystarPayerHandler = {
  id: "bcbs-ppo",
  name: "BCBS PPO",
  portalPayerName: "BCBS Florida (SB590)",
  insuranceNameAliases: ["bcbs ppo"],
  credentialProject: "FL2",
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    return parseWaystarEligibilityResult(payload, row, "bcbs-ppo");
  },
};
