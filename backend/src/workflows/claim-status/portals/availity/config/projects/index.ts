import { charmAvailityConfig } from "./charm";
import { medrevenuAvailityConfig } from "./medrevenu";
import { minimaxAvailityConfig } from "./minimax";
import { type AvailityProjectConfig } from "./types";

export const AVAILITY_PROJECT_CONFIGS: Record<string, AvailityProjectConfig> = {
  minimax: minimaxAvailityConfig,
  medrevenu: medrevenuAvailityConfig,
  charm: charmAvailityConfig,
};

export function getAvailityProjectConfig(projectId: string): AvailityProjectConfig {
  const config = AVAILITY_PROJECT_CONFIGS[projectId];
  if (!config) {
    throw new Error(`Unsupported Availity project configuration: ${projectId}`);
  }
  return config;
}

export { DEFAULT_AVAILITY_REQUIRED_FIELDS } from "./types";
export type {
  AvailityMatchingPolicy,
  AvailityPortalSelections,
  AvailityProjectConfig,
  AvailityProjectFieldConfig,
  AvailityProviderSelectionMode,
  AvailityRuleWhen,
  AvailitySelectionRule,
  AvailityTabId,
} from "./types";
