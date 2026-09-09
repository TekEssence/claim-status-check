import type { WaystarPayerHandler } from "../types";
import { bcbsPpoPayer } from "../bcbs-ppo";

/** Resolved only for MedRevenue through its project routing rules. */
export const medRevenueBlueShieldPayer: WaystarPayerHandler = {
  id: "blue-shield",
  name: "Blue Shield",
  portalPayerName: "Blue Shield California(SB542)",
  insuranceNameAliases: ["Blue Shield", "BlueShield"],
  requiredFields: ["memberId", "dateOfBirth"],
  parseResult(payload, row) {
    return { ...bcbsPpoPayer.parseResult(payload, row), payerId: "blue-shield" };
  },
};
