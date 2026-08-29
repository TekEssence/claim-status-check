import type { AvailityProjectConfig } from "./types";

export const medrevenuAvailityConfig: AvailityProjectConfig = {
  id: "medrevenu",
  fields: {
    // Set this once the single Medrevenu Availity state is confirmed.
    "Portal State": { defaultValue: "" },
    "Payer Name": { aliases: ["Responsible Payer", "Payer Name"] },
    "Service Date": { aliases: ["DOS", "Service Date"] },
    Charges: { aliases: ["Billed Amount", "Line Billed Amount", "Charges"] },
    "Line Billed Amount": { aliases: ["Billed Amount", "Line Billed Amount", "Charges"] },
    "Account Number": { aliases: ["Account Number", "Account No", "Account"] },
    Episode_DOS: { aliases: ["Episode_DOS", "Episode DOS", "Episode Dos"] },
    Group: { aliases: ["Group"] },
    "Subscriber No": { aliases: ["Member ID", "Subscriber No"] },
    "Patient DOB": { aliases: ["DOB", "Patient DOB"] },
  },
  requiredFields: ["Payer Name", "Service Date", "Charges"],
  selections: {
    state: { sourceField: "Portal State" },
    payer: { mappingField: "Payer Name" },
  },
  provider: {
    groupField: "Group",
    inputNameField: "Provider Name",
    requireGroup: true,
    requireMapping: true,
    includeInputNameAfterMapping: true,
  },
  matching: {
    matchBilledAmount: false,
    memberIdMode: "whenPresent",
    patientNameFallback: true,
    patientNameWithoutInitialFallback: true,
    fuzzyPatientNameFallback: false,
    reportCombinedMemberPatientMismatch: true,
    allowFuzzyProviderSelection: false,
  },
  preprocessingStrategy: "sumChargesByAccountEpisode",
  outputStrategy: "cptLineDetail",
};
