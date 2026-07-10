import type { WaystarPayerHandler } from "../types";

export const blueCrossBlueShieldPayer: WaystarPayerHandler = {
  id: "blue-cross-blue-shield",
  name: "Blue Cross Blue Shield",
  portalPayerName: "Blue Cross Blue Shield",
  insuranceNameAliases: [
    "blue cross blue shield",
    "blue cross and blue shield",
    "bcbs",
    "bluecross blueshield",
    "blue shield",
    "blue cross",
  ],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult() {
    throw new Error("The Waystar Blue Cross Blue Shield response parser has not been configured.");
  },
};
