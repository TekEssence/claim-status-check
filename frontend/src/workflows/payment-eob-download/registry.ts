import { availityRemittanceFrontendPortalConfig } from "./portals/availity-remittance/portal-config";
import { instamedRemittanceFrontendPortalConfig } from "./portals/instamed-remittance/portal-config";

export type PaymentEobPortalConfig =
  | typeof availityRemittanceFrontendPortalConfig
  | typeof instamedRemittanceFrontendPortalConfig;

export const paymentEobPortals: readonly PaymentEobPortalConfig[] = [
  availityRemittanceFrontendPortalConfig,
  instamedRemittanceFrontendPortalConfig,
];

export function getPaymentEobPortal(portalId: string | null) {
  return paymentEobPortals.find((portal) => portal.id === portalId) ?? null;
}
