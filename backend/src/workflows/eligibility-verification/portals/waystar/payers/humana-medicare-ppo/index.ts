import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const humanaMedicarePpoPayer: WaystarPayerHandler = {
  id: "humana-medicare-ppo",
  name: "HUMANA MEDICARE PPO",
  portalPayerName: "Humana(61101)",
  insuranceNameAliases: [
    "humana medicare ppo",
    "humana ppo",
    "humana medicare",
  ],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    return parseWaystarEligibilityResult(payload, row, "humana-medicare-ppo");
  },
};
