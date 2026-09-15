import type { EligibilityProjectId } from "../../../../projects";
import { medRevenueAvailityConfig } from "./medrevenue";
import { minimaxAvailityConfig } from "./minimax";
import type { AvailityProjectConfig } from "./types";

const configs: Readonly<Record<EligibilityProjectId, AvailityProjectConfig>> = {
  minimax: minimaxAvailityConfig,
  medrevenue: medRevenueAvailityConfig,
};
export function getAvailityProjectConfig(projectId: EligibilityProjectId): AvailityProjectConfig {
  return configs[projectId];
}
export type { AvailityProjectConfig } from "./types";
