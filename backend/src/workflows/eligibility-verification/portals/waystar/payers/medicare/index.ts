import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const medicarePayer: WaystarPayerHandler = {
  id: "medicare",
  name: "Medicare",
  portalPayerName: "Medicare A & B Eligibility (All States) (Z1073)",
  insuranceNameAliases: [
    "medicare",
    "traditional medicare",
    "original medicare",
    "medicare part a",
    "medicare part b",
  ],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    return parseWaystarEligibilityResult(payload, row, "medicare");
  },
};
