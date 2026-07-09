import type { WaystarPayerHandler } from "../types";

export const medicarePayer: WaystarPayerHandler = {
  id: "medicare",
  name: "Medicare",
  portalPayerName: "Medicare",
  insuranceNameAliases: [
    "medicare",
    "traditional medicare",
    "original medicare",
    "medicare part a",
    "medicare part b",
  ],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult() {
    throw new Error("The Waystar Medicare response parser has not been configured.");
  },
};
