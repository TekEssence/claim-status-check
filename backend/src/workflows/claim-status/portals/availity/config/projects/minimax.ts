import type { AvailityProjectConfig } from "./types";

export const minimaxAvailityConfig: AvailityProjectConfig = {
  id: "minimax",
  fields: {
    // Set this once the single Minimax Availity state is confirmed.
    "Portal State": { defaultValue: "" },
  },
  selections: {
    state: { sourceField: "Portal State" },
    payer: { mappingField: "Payer Name" },
  },
  matching: {
    matchBilledAmount: true,
    memberIdMode: "required",
    patientNameFallback: false,
    patientNameWithoutInitialFallback: false,
    fuzzyPatientNameFallback: false,
    reportCombinedMemberPatientMismatch: false,
    allowFuzzyProviderSelection: false,
  },
  preprocessingStrategy: "none",
  outputStrategy: "default",
};
