import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const umrPayer: WaystarPayerHandler = {
  id: "umr",
  name: "UMR",
  portalPayerName: "UMR (39026)",
  insuranceNameAliases: ["umr", "umr insurance", "united medical resources"],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    return parseWaystarEligibilityResult(payload, row, "umr");
  },
};
