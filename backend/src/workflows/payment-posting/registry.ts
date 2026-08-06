import { UnknownPortalError } from "../../core/errors";
import type { AutomationRunner } from "../types";
import { createAdvancedMdPaymentPostingRunner } from "./portals/advancedmd/scraper";

export const paymentPostingPortalRegistry = {
  advancedmd: createAdvancedMdPaymentPostingRunner,
} satisfies Record<string, () => AutomationRunner>;

export function getPaymentPostingRunner(portalId: string): AutomationRunner {
  const factory = paymentPostingPortalRegistry[portalId as keyof typeof paymentPostingPortalRegistry];
  if (!factory) throw new UnknownPortalError(portalId);
  return factory();
}

