import type { PaymentPostingPortalConfig } from "../../types";

export const advancedMdPaymentPostingConfig = {
  id: "advancedmd",
  name: "AdvancedMD",
  workflowId: "payment-posting",
  dryRun: true,
  supportsScreenshots: true,
  supportsOutputWorkbook: true,
  supportsPosting: false,
  runtime: {
    supportsLocal: true,
    supportsDeployed: false,
    requiresVpn: false,
  },
} satisfies PaymentPostingPortalConfig;

