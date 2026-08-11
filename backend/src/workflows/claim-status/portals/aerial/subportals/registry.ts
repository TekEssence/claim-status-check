import { normalizeAerialSubportalName, type AerialSubportal, type AerialSubportalDefinition } from "../common/subportal";
import { citrusValleySubportal } from "./CitrusValley";
import { pmgSubportal } from "./PMG";

export const aerialSubportals: readonly AerialSubportalDefinition[] = [pmgSubportal, citrusValleySubportal];

export function getAerialSubportal(id: AerialSubportal): AerialSubportalDefinition {
  return aerialSubportals.find((subportal) => subportal.id === id) ?? pmgSubportal;
}

export function resolveAerialSubportal(value: FormDataEntryValue | null): AerialSubportalDefinition {
  const requested = normalizeAerialSubportalName(value);
  if (!requested) return pmgSubportal;

  const subportal = aerialSubportals.find((candidate) =>
    candidate.aliases.some((alias) => normalizeAerialSubportalName(alias) === requested)
    || normalizeAerialSubportalName(candidate.id) === requested
  );

  if (subportal) return subportal;
  throw new Error(`Unsupported Aerial subportal: ${String(value).trim()}.`);
}
