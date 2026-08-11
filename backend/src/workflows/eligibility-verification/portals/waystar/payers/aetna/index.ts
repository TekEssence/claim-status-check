import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const aetnaPayer: WaystarPayerHandler = {
  id: "aetna",
  name: "AETNA",
  portalPayerName: "Aetna (60054)",
  insuranceNameAliases: ["aetna", "aetna insurance"],
  credentialProject: "FL2",
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    return parseWaystarEligibilityResult(payload, row, "aetna");
  },
};
