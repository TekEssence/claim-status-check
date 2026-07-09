import type { WaystarPayerHandler } from "../types";

export const arpPayer: WaystarPayerHandler = {
  id: "arp",
  name: "ARP",
  portalPayerName: "ARP",
  insuranceNameAliases: ["arp"],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult() {
    throw new Error("The Waystar ARP response parser has not been configured.");
  },
};
