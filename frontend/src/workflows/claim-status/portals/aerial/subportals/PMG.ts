import type { AerialSubportalDefinition } from "../common/types";

export const pmgSubportal: AerialSubportalDefinition = {
  id: "pmg",
  label: "PMG",
  description: "Aerial claim-status workflow",
  credentialHelperText: "Existing PMG environment credentials remain supported when no login file is uploaded.",
  requiresCredentialFile: false,
};
