import { UnknownPortalError } from "../../core/errors";
import type { AutomationRunner } from "../types";
import { createAvailityRemittanceRunner } from "./portals/availity-remittance/scraper";
import { createInstamedRemittanceRunner } from "./portals/instamed-remittance/scraper";

export const paymentEobPortalRegistry = {
  "availity-remittance": createAvailityRemittanceRunner,
  "instamed-remittance": createInstamedRemittanceRunner,
} satisfies Record<string, () => AutomationRunner>;

export function getPaymentEobRunner(portalId: string): AutomationRunner {
  const factory = paymentEobPortalRegistry[portalId as keyof typeof paymentEobPortalRegistry];
  if (!factory) throw new UnknownPortalError(portalId);
  return factory();
}
