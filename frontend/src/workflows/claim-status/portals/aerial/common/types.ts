export type AerialSubportal = "pmg" | "citrus-valley";

export type AerialSubportalDefinition = {
  id: AerialSubportal;
  label: string;
  description: string;
  credentialHelperText: string;
  requiresCredentialFile: boolean;
};
