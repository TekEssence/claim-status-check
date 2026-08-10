import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const avMedPayer: WaystarPayerHandler = {
  id: "av-med",
  name: "AV Med",
  portalPayerName: "AvMed (59274)",
  insuranceNameAliases: ["av med", "avmed", "avmed health plans"],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  serviceTypeCode: "98",
  patientLookupCode: "10",
  parseResult(payload, row) {
    return parseWaystarEligibilityResult(payload, row, "av-med");
  },
};
