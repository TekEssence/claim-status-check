import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const amerigroupWellpointPayer: WaystarPayerHandler = {
  id: "amerigroup-wellpoint",
  name: "Amerigroup Wellpoint",
  portalPayerName: "Amerigroup Wellpoint (WLPNT)",
  insuranceNameAliases: [
    "amerigroup",
    "amerigroup wellpoint",
    "wellpoint amerigroup",
  ],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    return parseWaystarEligibilityResult(payload, row, "amerigroup-wellpoint", true);
  },
};