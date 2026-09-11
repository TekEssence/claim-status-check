import { DEFAULT_AVAILITY_REQUIRED_FIELDS, type AvailityProjectConfig } from "./types";

const SERVICE_DATES_ONLY: NonNullable<AvailityProjectConfig["tabPriority"]> = ["serviceDates"];
const HIPAA_STANDARD_ONLY: NonNullable<AvailityProjectConfig["tabPriority"]> = ["hipaaStandard"];
const DEFAULT_TAB_PRIORITY: NonNullable<AvailityProjectConfig["tabPriority"]> = ["serviceDates", "hipaaStandard", "member", "claimHistory"];

export const charmAvailityConfig: AvailityProjectConfig = {
  id: "charm",
  fields: {
    "Claim No": { aliases: ["Invoice #", "Invoice Number", "Invoice"] },
    "Payer Name": { aliases: ["Master Payer Name", "Payer Name"] },
    "Portal Payer Name": { aliases: ["Payer to choose in Availity"] },
    "Portal State": { aliases: ["State to choose in Availity"] },
    "Patient Name": {
      aliases: ["Patient Name"],
      combineAliases: [["Patient first name", "Patient last name"]],
      normalizer: "stripBracketedPatientId",
    },
    "Patient ID": { aliases: ["Patient Name"], normalizer: "extractBracketedPatientId" },
    "Patient DOB": { aliases: ["Date Of Birth", "Date of Birth", "DOB"], normalizer: "dateToMmDdYyyy" },
    "Subscriber No": { aliases: ["Insured's ID", "Insured ID", "Member ID", "Subscriber No"] },
    "Service Date": { aliases: ["Date Of Service", "Date of Service", "DOS", "Service Date"], normalizer: "dateToMmDdYyyy" },
    Charges: { aliases: ["Claim Amount", "Charges", "Billed Amount"] },
    "Provider Name": { aliases: ["Provider Name"], normalizer: "stripBracketedProviderId" },
    "Provider NPI": { aliases: ["Provider NPI"] },
    "Provider Tax ID": { aliases: ["Tax ID", "Provider Tax ID", "Provider TIN"] },
    Group: { aliases: ["Practice", "Group", "Organization Group"] },
  },
  outputHeaderMappings: {
    Practice: "Group",
    "Claim Amount": "Charges",
  },
  additionalOutputHeaders: ["Patient ID", "Patient Identity Match", "Availity Selection", "Availity Match Details"],
  patientIdentityOutput: {
    patientIdField: "Patient ID",
    matchStatusField: "Patient Identity Match",
    mismatchStatus: "Patient name not matched; Patient ID matched",
  },
  requiredFields: [...DEFAULT_AVAILITY_REQUIRED_FIELDS, "Portal Payer Name", "Portal State", "Group"],
  selections: {
    organization: {
      sourceField: "Group",
      values: {
        "Open Mind": "Open Mind Health",
        Matushka: "Open Mind Health",
        ICM: "Institute of Complementary Medicine",
        "Feel Better": "FEEL BETTER BEHAVIORAL HEALTH SERVICES LLC",
        Columbia: "Columbia River Natural Medicine, LLC",
        "Grey Matters": "William Nields, PLLC",
        Dumont: "Dumont Florida PLLC",
        "Premier Health": "Premier Health",
        Premier: "Premier Health",
        Bentonville: "BENTONVILLE PEDIATRICS, P.A.",
        Amanda: "Open Mind Health",
        Northbay: "Fairhaven Integrative Health",
        Sears: "Open Mind Health",
        Joanne: "Open Mind Health",
        Sharon: "Open Mind Health",
        Livewell: "Livewell LLC",
        Ren: "The Ren clinic",
        Healthymind: "The Healthy Mind center",
        "Total body": "Open Mind Health",
      },
      skipValues: ["Sharon"],
      required: true,
    },
    state: { sourceField: "Portal State" },
    payer: { directField: "Portal Payer Name", mappingField: "Payer Name" },
  },
  selectionRules: [
    {
      when: {
        practice: "Open Mind",
        login: "rcmben",
        state: "California",
        payer: "AETNA (COMMERCIAL & MEDICARE)",
      },
      use: {
        organization: "Open Mind Health",
        providerName: "OPEN MIND MENTAL HEALTH PHYSICIANS, INC.",
        providerMode: "groupNameFirst",
        tabPriority: SERVICE_DATES_ONLY,
      },
    },
    {
      when: {
        practice: "Open Mind",
        login: "rcmben",
        state: "California",
      },
      use: {
        organization: "Open Mind Health",
        providerName: "OPEN MIND MENTAL HEALTH PHYSICIANS, INC.",
        providerMode: "groupNameFirst",
      },
    },
    {
      when: {
        practice: "Feel Better",
        login: "rcmjeff",
        state: "Maryland",
        payer: "Carelon Behavioral Health",
      },
      use: {
        organization: "Open Mind Health",
        providerName: "OPEN MIND MENTAL HEALTH PHYSICIANS, INC.",
        providerMode: "groupNameOnly",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Feel Better",
        login: "rcmben",
        state: "Maryland",
        payer: [
          "Carelon Behavioral Health",
          "AETNA (COMMERCIAL & MEDICARE)",
          "CAREFIRST BLUECROSS BLUESHIELD",
          "JOHNS HOPKINS ADVANTAGE MD",
          "WELLPOINT",
          "HUMANA",
        ],
      },
      use: {
        organization: "FEEL BETTER BEHAVIORAL HEALTH SERVICES LLC",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Grey Matters",
        login: "rcmbrandon",
        state: "Florida",
        payer: ["FLORIDA BLUE MEDICARE", "AETNA (COMMERCIAL & MEDICARE)"],
      },
      use: {
        organization: "William Nields, PLLC",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Dumont",
        login: ["rcmbrandon", "rcmsam"],
        state: ["Florida", "New York"],
        payer: [
          "AETNA (COMMERCIAL & MEDICARE)",
          "ANTHEM BCBS NY",
          "FLORIDA BLUE MEDICARE",
          "Carelon Behavioral Health",
        ],
      },
      use: {
        organization: "Dumont Florida PLLC",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Northbay",
        login: "rcmsam",
        state: "Washington",
        payer: ["REGENCE BLUESHIELD", "AETNA (COMMERCIAL & MEDICARE)"],
      },
      use: {
        organization: "Fairhaven Integrative Health",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Bentonville",
        login: "rcmsam",
        state: "Arkansas",
        payer: [
          "ARKANSAS BCBS OTHER BLUE PLANS",
          "AETNA (COMMERCIAL & MEDICARE)",
          "Qualchoice",
          "ARKANSAS TOTAL CARE",
        ],
      },
      use: {
        organization: "BENTONVILLE PEDIATRICS, P.A.",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Sears",
        login: "rcmsam",
        state: "California",
        payer: ["AETNA (COMMERCIAL & MEDICARE)", "ANTHEM-CA"],
      },
      use: {
        organization: "Open Mind Health",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Matushka",
        login: "rcmsam",
        state: "Idaho",
        payer: ["MAGELLAN HEALTHCARE", "AETNA (COMMERCIAL & MEDICARE)", "REGENCE BLUESHIELD OF IDAHO"],
      },
      use: {
        organization: "Open Mind Health",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "ICM",
        login: "rcmben",
        state: "Washington",
        payer: [
          "PREMERA BLUE CROSS (WA)",
          "REGENCE BLUESHIELD",
          "RGA - Regence Group Administrators",
          "AETNA (COMMERCIAL & MEDICARE)",
          "COORDINATED CARE",
          "HMA - Healthcare Management Administrators",
          "Asuris Northwest Health",
        ],
      },
      use: {
        organization: "Institute of Complementary Medicine",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Healthymind",
        login: "rcmbrandon",
        state: "California",
        payer: ["ANTHEM-CA", "AETNA (COMMERCIAL & MEDICARE)"],
      },
      use: {
        organization: "The Healthy Mind center",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Total body",
        login: "rcmjeff",
        state: "Illinois",
        payer: ["AETNA (COMMERCIAL & MEDICARE)", "BCBSIL"],
      },
      use: {
        organization: "Open Mind Health",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Joanne",
        login: "rcmjeff",
        state: "Maryland",
        payer: ["AETNA (COMMERCIAL & MEDICARE)", "CAREFIRST BLUECROSS BLUESHIELD"],
      },
      use: {
        organization: "Open Mind Health",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Sharon",
        login: "rcmjeff",
        state: "Connecticut",
        payer: ["ANTHEM-CT", "AETNA (COMMERCIAL & MEDICARE)"],
      },
      use: {
        organization: "Open Mind Health",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Livewell",
        login: "rcmben",
        state: "Washington",
        payer: ["REGENCE BLUESHIELD", "AETNA (COMMERCIAL & MEDICARE)"],
      },
      use: {
        organization: "Livewell LLC",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Amanda",
        login: "rcmben",
        state: "Connecticut",
        payer: ["AETNA (COMMERCIAL & MEDICARE)", "ANTHEM-CT"],
      },
      use: {
        organization: "Open Mind Health",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Ren",
        login: "rcmben",
        state: "Oregon",
        payer: ["REGENCE BCBS OF OREGON", "AETNA (COMMERCIAL & MEDICARE)"],
      },
      use: {
        organization: "The Ren clinic",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Premier Health",
        login: "rcmben",
        state: "New Hampshire",
        payer: ["HUMANA", "ANTHEM - NH"],
      },
      use: {
        organization: "Premier Health",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Columbia",
        login: "rcmsam",
        state: "Oregon",
        payer: ["Aetna", "HUMANA", "PROVIDENCE HEALTH PLAN POWERED BY COLLECTIVE HEALTH"],
      },
      use: {
        organization: "Columbia River Natural Medicine, LLC",
        providerMode: "individualNpiFirst",
        tabPriority: HIPAA_STANDARD_ONLY,
      },
    },
    {
      when: {
        practice: "Feel Better",
        login: "rcmjeff",
      },
      use: {
        organization: "Open Mind Health",
        providerMode: "individualNpiFirst",
      },
    },
  ],
  tabPriority: DEFAULT_TAB_PRIORITY,
  provider: {
    groupField: "Group",
    inputNameField: "Provider Name",
    inputNpiField: "Provider NPI",
    inputTaxIdField: "Provider Tax ID",
    requireProvider: true,
    allowInputNameFallback: true,
    includeInputNameAfterMapping: true,
  },
  matching: {
    matchBilledAmount: true,
    memberIdMode: "disabled",
    patientNameFallback: false,
    patientNameWithoutInitialFallback: false,
    fuzzyPatientNameFallback: false,
    patientIdFallback: true,
    reportCombinedMemberPatientMismatch: false,
    allowFuzzyProviderSelection: true,
  },
  preprocessingStrategy: "groupCharmByStatePracticePayer",
  outputStrategy: "default",
};
