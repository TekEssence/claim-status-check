import type { AerialSubportalDefinition } from "../common/types";

export const citrusValleySubportal: AerialSubportalDefinition = {
  id: "citrus-valley",
  label: "Citrus Valley",
  description: "Aerial claim-status workflow",
  credentialHelperText: "The login file must contain a Citrus Valley row in the Sub portal column.",
  requiresCredentialFile: true,
};
