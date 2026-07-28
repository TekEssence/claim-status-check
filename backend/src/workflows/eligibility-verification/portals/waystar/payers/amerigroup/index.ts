import type { WaystarPayerHandler } from "../types";
import { parseBlueCrossBlueShieldResult } from "../blue-cross-blue-shield";

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
    return parseBlueCrossBlueShieldResult(payload, row, "amerigroup-wellpoint", true);
  },
};