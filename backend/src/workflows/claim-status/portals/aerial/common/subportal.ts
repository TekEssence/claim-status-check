export type AerialSubportal = "pmg" | "citrus-valley";

export type AerialCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  successUrlFragment?: string;
  claimsUrl: string;
};

export type AerialSubportalDefinition = {
  id: AerialSubportal;
  label: string;
  aliases: readonly string[];
  allowEnvironmentCredentials: boolean;
  allowLegacyUnscopedCredentials: boolean;
};

export function normalizeAerialSubportalName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}
