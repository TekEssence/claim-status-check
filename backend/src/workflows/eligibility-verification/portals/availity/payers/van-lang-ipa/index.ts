import type { AvailityEligibilityPayerHandler } from "../types";
import { runVanLangIpaAvailityEligibilityWorkflow } from "./workflow";

export const vanLangIpaAvailityEligibilityPayer: AvailityEligibilityPayerHandler = {
  id: "van-lang-ipa",
  name: "Van Lang IPA",
  run: runVanLangIpaAvailityEligibilityWorkflow,
};
