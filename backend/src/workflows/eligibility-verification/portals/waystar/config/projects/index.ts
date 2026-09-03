import type { EligibilityProjectId } from "../../../../projects";
import { medRevenueWaystarConfig } from "./medrevenue";
import { minimaxWaystarConfig } from "./minimax";
import type { WaystarPayerProjectConfig, WaystarProjectConfig } from "./types";

export const WAYSTAR_PROJECT_CONFIGS: Readonly<Record<EligibilityProjectId, WaystarProjectConfig>> = {
  minimax: minimaxWaystarConfig,
  medrevenue: medRevenueWaystarConfig,
};

export function getWaystarProjectConfig(projectId: EligibilityProjectId): WaystarProjectConfig {
  return WAYSTAR_PROJECT_CONFIGS[projectId];
}

export function getWaystarPayerProjectConfig(config: WaystarProjectConfig, payerId: string): WaystarPayerProjectConfig {
  const payer = config.payers?.[payerId] ?? {};
  const selectorFallbacks = { ...config.selectorFallbacks, ...payer.selectorFallbacks };
  const outputMapping = { ...config.outputMapping, ...payer.outputMapping };
  const settings = { ...config.settings, ...payer.settings };
  return {
    ...payer,
    ...(Object.keys(selectorFallbacks).length ? { selectorFallbacks } : {}),
    ...(Object.keys(outputMapping).length ? { outputMapping } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  };
}

export type { WaystarPayerProjectConfig, WaystarProjectConfig } from "./types";
