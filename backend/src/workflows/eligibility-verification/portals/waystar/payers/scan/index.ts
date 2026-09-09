import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

/** Available only through MedRevenue's project routing. */
export const medRevenueScanPayer: WaystarPayerHandler = {
  id: "scan",
  name: "SCAN",
  portalPayerName: "Scan Health Plan - California(72261)",
  insuranceNameAliases: ["SCAN", "Scan Health Plan"],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    return parseWaystarEligibilityResult(payload, row, "scan");
  },
};
