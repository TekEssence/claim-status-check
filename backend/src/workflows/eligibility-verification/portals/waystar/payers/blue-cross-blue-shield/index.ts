import type {
  EligibilityCoverageStatus,
  EligibilityInputRow,
  EligibilityResult,
} from "../../../../types";
import type { WaystarPayerHandler } from "../types";

type BcbsHealthBenefitPlanCoveragePayload = {
  overallStatus?: unknown;
  sectionStatuses?: Array<{ title?: unknown; status?: unknown }>;
  subscriberInformation?: BcbsSubscriberInformation;
  patientInformation?: BcbsPatientInformation;
  subscriberCoverageInformation?: BcbsSubscriberCoverageInformation;
  general?: { primaryCareProvider?: unknown };
  healthBenefitPlanCoverage?: {
    coverageDescription?: unknown;
    eligibilityBeginDate?: unknown;
    eligibilityEndDate?: unknown;
    planStatus?: unknown;
    planType?: unknown;
    general?: { coverageDescription?: unknown };
    benefitSections?: BcbsProfessionalOfficeSection[];
  };
  professionalOffice?: BcbsProfessionalOfficeSection[];
};

type BcbsSubscriberInformation = {
  patientName?: unknown;
  address?: unknown;
  memberId?: unknown;
  dateOfBirth?: unknown;
  sex?: unknown;
};

type BcbsPatientInformation = {
  patientName?: unknown;
  address?: unknown;
  dateOfBirth?: unknown;
  sex?: unknown;
  relationshipToSubscriber?: unknown;
};
type BcbsSubscriberCoverageInformation = {
  groupNumber?: unknown;
  planDate?: unknown;
  premiumPaidToDateEnd?: unknown;
  insuranceType?: unknown;
};

export type BcbsProfessionalOfficeEntry = {
  type?: unknown;
  value?: unknown;
  period?: unknown;
  placeOfService?: unknown;
  payerNote?: unknown;
  includedProviderSpecialties?: unknown;
};

export type BcbsProfessionalOfficeSection = {
  network?: unknown;
  coverageLevel?: unknown;
  entries?: BcbsProfessionalOfficeEntry[];
};

const commonRequiredFields = ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"];

export const blueCrossBlueShieldTexasPayer: WaystarPayerHandler = {
  id: "blue-cross-blue-shield-texas",
  name: "Blue Cross Blue Shield Texas",
  portalPayerName: "BCBS Texas(SB900)",
  insuranceNameAliases: [
    "blue cross and blue shield of texas",
    "blue cross blue shield of texas",
    "blue cross blue shield texas",
    "bcbs texas",
    "bcbstx",
  ],
  requiredFields: commonRequiredFields,
  parseResult(payload, row) {
    return parseBlueCrossBlueShieldResult(payload, row, "blue-cross-blue-shield-texas");
  },
};

export const blueCrossBlueShieldFloridaPayer: WaystarPayerHandler = {
  id: "blue-cross-blue-shield-florida",
  name: "Blue Cross Blue Shield Florida",
  portalPayerName: "BCBS Florida(SB590)",
  insuranceNameAliases: [
    "blue cross and blue shield of florida",
    "blue cross blue shield of florida",
    "blue cross blue shield florida",
    "bcbs florida",
    "bcbsfl",
    "florida blue",
  ],
  requiredFields: commonRequiredFields,
  parseResult(payload, row) {
    return parseBlueCrossBlueShieldResult(payload, row, "blue-cross-blue-shield-florida");
  },
};

export function parseBlueCrossBlueShieldResult(
  payload: unknown,
  row: EligibilityInputRow,
  payerId: string,
): EligibilityResult {
  const result = asBcbsPayload(payload);
  const coverage = result.healthBenefitPlanCoverage;
  const sectionStatuses = result.sectionStatuses ?? [];
  const planStatus = asText(coverage?.planStatus) ||
    asText(result.overallStatus) ||
    sectionStatuses.map((section) => asText(section.status)).find(Boolean);
  const coverageStatus = normalizeCoverageStatus(planStatus);
  const planType = normalizePlanType(asText(coverage?.planType));
  const planName = asText(coverage?.coverageDescription) ||
    sectionStatuses.map((section) => asText(section.title)).filter(Boolean).join(", ") ||
    undefined;
  const effectiveDate = asText(coverage?.eligibilityBeginDate);
  const terminationDate = asText(coverage?.eligibilityEndDate);
  const subscriber = result.subscriberInformation ?? {};
  const patient = result.patientInformation ?? {};
  const subscriberCoverage = result.subscriberCoverageInformation ?? {};
  const professionalOffice = selectProfessionalOfficeBenefits(
    result.professionalOffice,
    coverage?.benefitSections,
  );
  const benefits = coverage
    ? [{
        serviceType: "30 - Health Benefit Plan Coverage",
        coverageStatus,
        notes: planStatus || undefined,
      }]
    : sectionStatuses.map((section) => ({
        serviceType: asText(section.title) || "Waystar Eligibility",
        coverageStatus: normalizeCoverageStatus(asText(section.status)),
        notes: asText(section.status),
      }));

  return {
    rowIndex: row.originalIndex,
    payerId,
    coverageStatus,
    planType,
    planName,
    planStatus,
    effectiveDate,
    terminationDate,
    premiumPaidEndDate: asText(subscriberCoverage.premiumPaidToDateEnd),
    insuranceType: asText(subscriberCoverage.insuranceType),
    patientName: asText(patient.patientName) || asText(subscriber.patientName),
    relationshipToSubscriber: asText(patient.relationshipToSubscriber),
    address: asText(patient.address) || asText(subscriber.address),
    memberId: asText(subscriber.memberId),
    dateOfBirth: asText(patient.dateOfBirth) || asText(subscriber.dateOfBirth),
    sex: asText(patient.sex) || asText(subscriber.sex),
    groupNumber: asText(subscriberCoverage.groupNumber),
    planDate: asText(subscriberCoverage.planDate),
    primaryCareProvider: asText(result.general?.primaryCareProvider),
    coverageDescription: asText(coverage?.general?.coverageDescription) || planName,
    ...professionalOffice,
    benefits,
    metadata: {
      ...(coverage ? {
        healthBenefitPlanCoverage: {
          planType,
          planName,
          planStatus,
          eligibilityBeginDate: effectiveDate,
          eligibilityEndDate: terminationDate,
        },
      } : {}),
      sections: sectionStatuses,
      subscriberInformation: subscriber,
      patientInformation: patient,
      subscriberCoverageInformation: subscriberCoverage,
      professionalOffice,
    },
  };
}

export function selectProfessionalOfficeBenefits(
  sections?: BcbsProfessionalOfficeSection[],
  healthBenefitPlanSections?: BcbsProfessionalOfficeSection[],
): Pick<EligibilityResult, "coinsurance" | "copay" | "deductible" | "deductibleMet" | "outOfPocket" | "outOfPocketMet" | "inOutNetwork" | "specialistPayerNote"> {
  const selectedProfessionalSections = selectPreferredIndividualNetworkSections(sections);
  const professionalEntries = selectedProfessionalSections
    .flatMap((section) => section.entries ?? [])
    .filter((entry) => isOfficeOrUnspecified(entry.placeOfService));
  const selectedHealthBenefitSections = selectPreferredIndividualNetworkSections(healthBenefitPlanSections);
  const healthBenefitEntries = selectedHealthBenefitSections.flatMap((section) => section.entries ?? []);

  const healthCoinsurance = filterCoinsurance(healthBenefitEntries);
  const professionalCoinsurance = filterCoinsurance(professionalEntries);
  const selectedCoinsurance = preferEntries(healthCoinsurance, professionalCoinsurance);
  const healthCopay = healthBenefitEntries.filter((entry) => isCopay(entry.type));
  const professionalCopay = professionalEntries.filter((entry) => isCopay(entry.type));
  const selectedCopay = preferEntries(healthCopay, professionalCopay);
  const specialistCopay = selectedCopay.filter((entry) => isSpecialtyCopay(entry));
  const healthDeductible = healthBenefitEntries.filter((entry) => normalize(entry.type).includes("deductible"));
  const professionalDeductible = professionalEntries.filter((entry) => normalize(entry.type).includes("deductible"));
  const selectedDeductible = preferEntries(healthDeductible, professionalDeductible);
  const healthOop = filterOutOfPocket(healthBenefitEntries);
  const professionalOop = filterOutOfPocket(professionalEntries);
  const selectedOop = preferEntries(healthOop, professionalOop);

  const deductible = annualValue(selectedDeductible);
  const deductibleRemaining = remainingValue(selectedDeductible);
  const outOfPocket = annualValue(selectedOop);
  const outOfPocketRemaining = remainingValue(selectedOop);
  const selectedBenefitEntries = [
    ...selectedCoinsurance,
    ...selectedCopay,
    ...selectedDeductible,
    ...selectedOop,
  ];

  return {
    coinsurance: highestValue(selectedCoinsurance, "%"),
    copay: highestValue(specialistCopay.length > 0 ? specialistCopay : selectedCopay, "$"),
    deductible: formatMoney(deductible),
    deductibleMet: formatDifference(deductible, deductibleRemaining),
    outOfPocket: formatMoney(outOfPocket),
    outOfPocketMet: formatDifference(outOfPocket, outOfPocketRemaining),
    inOutNetwork: resolveNetwork(
      selectedHealthBenefitSections.length > 0
        ? selectedHealthBenefitSections
        : selectedProfessionalSections,
    ),
    specialistPayerNote: selectedBenefitEntries.some((entry) =>
      normalize(entry.payerNote).includes("specialist")
    ) ? "Specialist" : undefined,
  };
}

function preferEntries(
  healthBenefitEntries: BcbsProfessionalOfficeEntry[],
  professionalEntries: BcbsProfessionalOfficeEntry[],
): BcbsProfessionalOfficeEntry[] {
  return healthBenefitEntries.length > 0 ? healthBenefitEntries : professionalEntries;
}

function filterCoinsurance(entries: BcbsProfessionalOfficeEntry[]): BcbsProfessionalOfficeEntry[] {
  return entries.filter((entry) => {
    const type = normalize(entry.type);
    return type.includes("co insurance") || type.includes("coinsurance");
  });
}

function filterOutOfPocket(entries: BcbsProfessionalOfficeEntry[]): BcbsProfessionalOfficeEntry[] {
  return entries.filter((entry) => {
    const type = normalize(entry.type);
    return type.includes("out of pocket") || type === "oop";
  });
}
function resolveNetwork(sections: BcbsProfessionalOfficeSection[]): "INN" | "OON" | undefined {
  if (sections.some((section) => normalize(section.network).includes("out of network"))) return "OON";
  if (sections.some((section) => normalize(section.network).includes("in network"))) return "INN";
  return undefined;
}
function selectPreferredIndividualNetworkSections(
  sections?: BcbsProfessionalOfficeSection[],
): BcbsProfessionalOfficeSection[] {
  const available = (sections ?? []).filter((section) => (section.entries?.length ?? 0) > 0);
  const individual = available.filter((candidate) =>
    normalize(candidate.coverageLevel).includes("individual"),
  );
  const coverageCandidates = individual.length > 0 ? individual : available;
  const inNetwork = coverageCandidates.filter((candidate) => isInNetwork(candidate.network));
  return inNetwork.length > 0 ? inNetwork : coverageCandidates;
}

function isInNetwork(value: unknown): boolean {
  const network = normalize(value);
  return network.includes("in network") && !network.includes("out of network");
}

function isOffice(value: unknown): boolean {
  const text = normalize(value);
  return text === "office" || text.includes(" office");
}

function isOfficeOrUnspecified(value: unknown): boolean {
  return !normalize(value) || isOffice(value);
}

function hasIncludedProviderSpecialties(value: unknown): boolean {
  const text = normalize(value);
  return Boolean(text) && !["none", "n a", "not applicable", "unknown"].includes(text);
}

function isCopay(value: unknown): boolean {
  const type = normalize(value);
  return ["copay", "co pay", "copayment", "co payment"].some((name) => type.includes(name));
}

function isSpecialtyCopay(entry: BcbsProfessionalOfficeEntry): boolean {
  return normalize(entry.payerNote).includes("specialist") ||
    hasIncludedProviderSpecialties(entry.includedProviderSpecialties);
}

function highestValue(entries: BcbsProfessionalOfficeEntry[], unit: "$" | "%"): string | undefined {
  const values = entries.map((entry) => ({ raw: asText(entry.value), amount: numericValue(entry.value) }))
    .filter((entry): entry is { raw: string; amount: number } => entry.raw !== undefined && entry.amount !== undefined);
  if (values.length === 0) return undefined;
  const highest = values.reduce((best, current) => current.amount > best.amount ? current : best);
  return unit === "%" ? `${formatNumber(highest.amount)}%` : formatMoney(highest.amount);
}

function annualValue(entries: BcbsProfessionalOfficeEntry[]): number | undefined {
  const annual = entries.filter((entry) => entryQualifier(entry).includes("calendar year"));
  return maximumNumeric(annual.length > 0 ? annual : entries.filter((entry) => !entryQualifier(entry).includes("remaining")));
}

function remainingValue(entries: BcbsProfessionalOfficeEntry[]): number | undefined {
  return maximumNumeric(entries.filter((entry) => entryQualifier(entry).includes("remaining")));
}

function entryQualifier(entry: BcbsProfessionalOfficeEntry): string {
  return `${normalize(entry.period)} ${normalize(entry.value)}`.trim();
}

function maximumNumeric(entries: BcbsProfessionalOfficeEntry[]): number | undefined {
  const values = entries.map((entry) => numericValue(entry.value)).filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function numericValue(value: unknown): number | undefined {
  const match = asText(value)?.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : undefined;
}

function formatDifference(total?: number, remaining?: number): string | undefined {
  if (total === undefined || remaining === undefined) return undefined;
  return formatMoney(Math.max(0, total - remaining));
}

function formatMoney(value?: number): string | undefined {
  return value === undefined ? undefined : `$${formatNumber(value)}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function normalize(value: unknown): string {
  return (asText(value) ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function asBcbsPayload(payload: unknown): BcbsHealthBenefitPlanCoveragePayload {
  if (!payload || typeof payload !== "object") return {};
  return payload as BcbsHealthBenefitPlanCoveragePayload;
}

function normalizeCoverageStatus(value?: string): EligibilityCoverageStatus {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("inactive")) return "inactive";
  if (normalized.includes("active")) return "active";
  if (normalized.includes("failed at payer") || normalized.includes("subscriber not found")) return "error";
  return "unknown";
}

function normalizePlanType(value?: string): string | undefined {
  if (!value) return undefined;
  const match = value.match(/\(([^)]+)\)/);
  return match?.[1]?.trim() || value.trim();
}

function asText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}
