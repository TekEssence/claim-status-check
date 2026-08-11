import type { AerialSubportal, AerialSubportalDefinition } from "../common/types";
import { citrusValleySubportal } from "./CitrusValley";
import { pmgSubportal } from "./PMG";

export const aerialSubportals: readonly AerialSubportalDefinition[] = [pmgSubportal, citrusValleySubportal];

export function getAerialSubportal(id: AerialSubportal | null): AerialSubportalDefinition | null {
  if (!id) return null;
  return aerialSubportals.find((subportal) => subportal.id === id) ?? null;
}
