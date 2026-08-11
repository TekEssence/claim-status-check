import { advancedMdPaymentPostingFrontendPortalConfig } from "./portals/advancedmd/portal-config";

export type PaymentPostingPortalConfig = typeof advancedMdPaymentPostingFrontendPortalConfig;

export const paymentPostingPortals: readonly PaymentPostingPortalConfig[] = [
  advancedMdPaymentPostingFrontendPortalConfig,
];

export function getPaymentPostingPortal(portalId: string | null) {
  return paymentPostingPortals.find((portal) => portal.id === portalId) ?? null;
}
