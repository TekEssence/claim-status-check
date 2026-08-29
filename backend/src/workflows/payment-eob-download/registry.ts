import { UnknownPortalError } from "../../core/errors";
import type { AutomationRunner } from "../types";
import { createAvailityRemittanceRunner } from "./portals/availity-remittance/scraper";
import { createEchoRemittanceRunner } from "./portals/echo-remittance/scraper";
import { createInstamedRemittanceRunner } from "./portals/instamed-remittance/scraper";
import { createJopariRunner } from "./portals/jopari/scraper";
import { createZelisRunner } from "./portals/zelis/scraper";
import { createWaystarPaymentEobRunner } from "./portals/waystar/scraper";

export const paymentEobPortalRegistry = {
  "availity-remittance": createAvailityRemittanceRunner,
  "echo-remittance": createEchoRemittanceRunner,
  "instamed-remittance": createInstamedRemittanceRunner,
  jopari: createJopariRunner,
  zelis: createZelisRunner,
  waystar: createWaystarPaymentEobRunner,
} satisfies Record<string, () => AutomationRunner>;

export function getPaymentEobRunner(portalId: string): AutomationRunner {
  const factory = paymentEobPortalRegistry[portalId as keyof typeof paymentEobPortalRegistry];
  if (!factory) throw new UnknownPortalError(portalId);
  return factory();
}
