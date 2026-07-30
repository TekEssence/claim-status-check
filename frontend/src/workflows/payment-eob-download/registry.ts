import { availityRemittanceFrontendPortalConfig } from "./portals/availity-remittance/portal-config";
import { instamedRemittanceFrontendPortalConfig } from "./portals/instamed-remittance/portal-config";
import { zelisFrontendPortalConfig } from "./portals/zelis/portal-config";

export type PaymentEobPortalConfig =
  | typeof availityRemittanceFrontendPortalConfig
  | typeof instamedRemittanceFrontendPortalConfig
  | typeof zelisFrontendPortalConfig;

export const paymentEobPortals: readonly PaymentEobPortalConfig[] = [
  availityRemittanceFrontendPortalConfig,
  instamedRemittanceFrontendPortalConfig,
  zelisFrontendPortalConfig,
];

export function getPaymentEobPortal(portalId: string | null) {
  return paymentEobPortals.find((portal) => portal.id === portalId) ?? null;
}
