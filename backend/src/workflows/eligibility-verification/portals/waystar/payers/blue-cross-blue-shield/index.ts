import type { WaystarPayerHandler } from "../types";

const commonRequiredFields = ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"];

export const blueCrossBlueShieldTexasPayer: WaystarPayerHandler = {
  id: "blue-cross-blue-shield-texas",
  name: "Blue Cross Blue Shield Texas",
  portalPayerName: "BCBS Texas(SB900)",
  insuranceNameAliases: [
    "blue cross and blue shield of texas",
    "blue cross blue shield of texas",
    "blue cross blue shield texas",
    "bcbs texas",
    "bcbstx",
  ],
  requiredFields: commonRequiredFields,
  parseResult() {
    throw new Error("The Waystar Blue Cross Blue Shield Texas response parser has not been configured.");
  },
};

export const blueCrossBlueShieldFloridaPayer: WaystarPayerHandler = {
  id: "blue-cross-blue-shield-florida",
  name: "Blue Cross Blue Shield Florida",
  portalPayerName: "BCBS Florida(SB590)",
  insuranceNameAliases: [
    "blue cross and blue shield of florida",
    "blue cross blue shield of florida",
    "blue cross blue shield florida",
    "bcbs florida",
    "bcbsfl",
    "florida blue",
  ],
  requiredFields: commonRequiredFields,
  parseResult() {
    throw new Error("The Waystar Blue Cross Blue Shield Florida response parser has not been configured.");
  },
};
