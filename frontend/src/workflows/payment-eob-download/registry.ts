import { availityRemittanceFrontendPortalConfig } from "./portals/availity-remittance/portal-config";

export type PaymentEobPortalConfig = typeof availityRemittanceFrontendPortalConfig;

export const paymentEobPortals: readonly PaymentEobPortalConfig[] = [
  availityRemittanceFrontendPortalConfig,
];

export function getPaymentEobPortal(portalId: string | null) {
  return paymentEobPortals.find((portal) => portal.id === portalId) ?? null;
}

