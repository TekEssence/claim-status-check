import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const cignaOpenAccessPlusPayer: WaystarPayerHandler = {
  id: "cigna-open-access-plus",
  name: "Cigna Open Access Plus",
  portalPayerName: "Cigna Health Plans (62308)",
  insuranceNameAliases: [
    "cigna",
    "cigna open access plus",
    "cigna open access plus oap",
    "cigna oap",
    "cigna baycare exclusive network",
    "cigna baycare share",
    "cigna ppo",
    "cigna baycare premium",
  ],
  credentialProject: "FL2",
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    return parseWaystarEligibilityResult(payload, row, "cigna-open-access-plus");
  },
};
