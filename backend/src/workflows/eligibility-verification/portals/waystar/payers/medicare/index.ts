import type { WaystarPayerHandler } from "../types";

type MedicareSection = {
  title: string;
  status: string;
  detailsText?: string;
};

type MedicareDetailEntry = {
  label: string;
  value: string;
};

export const medicarePayer: WaystarPayerHandler = {
  id: "medicare",
  name: "Medicare",
  portalPayerName: "Medicare A & B Eligibility (All States) (Z1073)",
  insuranceNameAliases: [
    "medicare",
    "traditional medicare",
    "original medicare",
    "medicare part a",
    "medicare part b",
  ],
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    const result = asMedicarePayload(payload);
    const sections = result.sectionStatuses.length > 0
      ? attachSectionDetails(result.sectionStatuses, result.bodyText)
      : extractSectionsFromBody(result.bodyText);
    const statuses = [
      result.overallStatus,
      ...sections.map((entry) => entry.status),
      ...extractStatusHints(result.bodyText),
    ].filter(Boolean);
    const coverageStatus = toCoverageStatus(statuses);
    const pharmacySection = findPharmacySection(sections);
    const otherCoverageSection = findOtherCoverageSection(sections);
    const primarySection = pharmacySection
      ?? sections.find((section) => /medicare\s+part\s+b/i.test(section.title))
      ?? sections[0]
      ?? { title: "Medicare", status: result.overallStatus, detailsText: result.bodyText };
    const portalFields = extractPortalFields(primarySection, otherCoverageSection, result.bodyText, Boolean(pharmacySection));
    const planName = primarySection.title || sections.map((entry) => entry.title).filter(Boolean).join(", ") || "Medicare";
    const planStatus = result.overallStatus || primarySection.status || "";
    const benefits = buildBenefits(primarySection, coverageStatus, portalFields, statuses, Boolean(pharmacySection));

    return {
      rowIndex: row.originalIndex,
      payerId: "medicare",
      coverageStatus,
      planName,
      planStatus,
      benefits,
      metadata: {
        overallStatus: result.overallStatus,
        sections,
        bodyText: result.bodyText,
        portalFields: {
          planName,
          planStatus,
          ...portalFields,
        },
      },
    };
  },
};

function asMedicarePayload(payload: unknown): {
  overallStatus: string;
  sectionStatuses: MedicareSection[];
  bodyText: string;
} {
  if (!payload || typeof payload !== "object") {
    return { overallStatus: "", sectionStatuses: [], bodyText: "" };
  }

  const record = payload as {
    overallStatus?: unknown;
    sectionStatuses?: unknown;
    bodyText?: unknown;
  };

  return {
    overallStatus: asText(record.overallStatus),
    sectionStatuses: Array.isArray(record.sectionStatuses)
      ? record.sectionStatuses.map((entry) => {
        const section = entry as { title?: unknown; status?: unknown; detailsText?: unknown };
        return {
          title: asText(section.title),
          status: asText(section.status),
          detailsText: asText(section.detailsText),
        };
      })
      : [],
    bodyText: asText(record.bodyText),
  };
}

function attachSectionDetails(sections: MedicareSection[], bodyText: string): MedicareSection[] {
  if (!bodyText.trim()) return sections;
  const lines = splitLines(bodyText);
  let cursor = 0;

  return sections.map((section, index) => {
    const titleIndex = findLineIndex(lines, section.title, cursor);
    if (titleIndex < 0) {
      return section;
    }

    const nextSection = sections[index + 1];
    const nextIndex = nextSection ? findLineIndex(lines, nextSection.title, titleIndex + 1) : -1;
    const sectionLines = lines.slice(titleIndex + 1, nextIndex >= 0 ? nextIndex : undefined);
    const detailsLines = section.status
      ? sectionLines.filter((line, lineIndex) => !(lineIndex === 0 && equalsText(line, section.status)))
      : sectionLines;

    cursor = titleIndex + 1;
    return {
      ...section,
      detailsText: detailsLines.join("\n").trim(),
    };
  });
}

function extractSectionsFromBody(bodyText: string): MedicareSection[] {
  const lines = splitLines(bodyText);
  const sections: MedicareSection[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const title = lines[index] || "";
    if (!/^medicare\s+part\s+[ab]$/i.test(title) && !/^other coverage$/i.test(title)) continue;

    const status = isStatusLine(lines[index + 1] || "") ? lines[index + 1] || "" : "";
    const detailsStart = status ? index + 2 : index + 1;
    let detailsEnd = lines.length;
    for (let cursor = detailsStart; cursor < lines.length; cursor += 1) {
      if (/^medicare\s+part\s+[ab]$/i.test(lines[cursor] || "") || /^other coverage$/i.test(lines[cursor] || "")) {
        detailsEnd = cursor;
        break;
      }
    }

    sections.push({
      title,
      status,
      detailsText: lines.slice(detailsStart, detailsEnd).join("\n").trim(),
    });
    index = detailsEnd - 1;
  }

  return sections;
}

function findPharmacySection(sections: MedicareSection[]): MedicareSection | undefined {
  return sections.find((section) =>
    parseDetailEntries(section.detailsText || "").some((entry) => entry.label === "Service Type" && /pharmacy/i.test(entry.value)),
  );
}

function findOtherCoverageSection(sections: MedicareSection[]): MedicareSection | undefined {
  return sections.find((section) => /^other coverage$/i.test(section.title));
}

function buildBenefits(
  section: MedicareSection,
  coverageStatus: "active" | "inactive" | "unknown" | "error",
  portalFields: Record<string, unknown>,
  statuses: string[],
  isPharmacy: boolean,
): Array<{ serviceType: string; coverageStatus: "active" | "inactive" | "unknown" | "error"; notes?: string }> {
  const serviceType = isPharmacy ? asText(portalFields.serviceType) || "Pharmacy" : section.title || "Medicare Part B";
  const notes = [section.status, asText(portalFields.payerNote), statuses.join(" | ")].filter(Boolean).join(" | ") || undefined;
  return [{ serviceType, coverageStatus, notes }];
}

function extractPortalFields(
  section: MedicareSection,
  otherCoverageSection: MedicareSection | undefined,
  bodyText: string,
  isPharmacy: boolean,
): Record<string, unknown> {
  const entries = parseDetailEntries(section.detailsText || "");
  const otherCoverageEntries = parseDetailEntries(otherCoverageSection?.detailsText || "");
  const summary = extractDeductibleSummary(bodyText);

  if (isPharmacy) {
    return {
      serviceType: valuesFor(entries, "Service Type").find((value) => /pharmacy/i.test(value)) || extractOtherCoverageServiceType(bodyText) || "Pharmacy",
    };
  }

  return {
    planDate: pickCoveragePlanDate(valuesFor(entries, "Plan Date")),
    payerNote: firstValue(entries, "Payer Note"),
    serviceType: firstValue(otherCoverageEntries, "Service Type") || extractOtherCoverageServiceType(bodyText),
    deductible: summary.medicareBYearlyDeductible,
    deductibleRemaining: summary.medicareBDeductibleRemaining,
    deductibleMet: summary.medicareBYearlyDeductible != null && summary.medicareBDeductibleRemaining != null
      ? roundCurrency(summary.medicareBYearlyDeductible - summary.medicareBDeductibleRemaining)
      : null,
    coInsurance: firstValue(entries, "Co-Insurance") || firstValue(entries, "Coinsurance"),
  };
}

function extractOtherCoverageServiceType(bodyText: string): string {
  const lines = splitLines(bodyText);
  const otherCoverageIndex = lines.findIndex((line) => /^other coverage information$/i.test(line) || /^other coverage$/i.test(line));
  if (otherCoverageIndex >= 0) {
    for (let index = otherCoverageIndex + 1; index < Math.min(lines.length, otherCoverageIndex + 40); index += 1) {
      if (/^service type$/i.test(lines[index] || "")) {
        return (lines[index + 1] || "").trim();
      }
      if (/^deductible remaining$/i.test(lines[index] || "") || /^medicare\s+part\s+[ab]$/i.test(lines[index] || "")) {
        break;
      }
    }
  }

  const flattenedMatch = bodyText.match(/other coverage information[\s\S]{0,1200}?service type\s*([A-Za-z][A-Za-z\s&\-\/]+?)(?:plan sponsor|payer|status|phone|url|insurance type|benefit date|plan number|plan network id number|deductible remaining|yearly deductible|$)/i);
  return flattenedMatch?.[1]?.replace(/\s+/g, " ").trim() || "";
}

function parseDetailEntries(detailsText: string): MedicareDetailEntry[] {
  const lines = splitLines(detailsText);
  const entries: MedicareDetailEntry[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const label = normalizeLabel(lines[index] || "");
    if (!label) continue;
    const nextLine = lines[index + 1] || "";
    if (!nextLine || normalizeLabel(nextLine)) continue;
    entries.push({ label, value: nextLine.trim() });
    index += 1;
  }

  return entries;
}

function normalizeLabel(value: string): string {
  const trimmed = value.trim();
  if (/^plan date$/i.test(trimmed)) return "Plan Date";
  if (/^payer note$/i.test(trimmed)) return "Payer Note";
  if (/^service type$/i.test(trimmed)) return "Service Type";
  if (/^deductible$/i.test(trimmed)) return "Deductible";
  if (/^co-insurance$/i.test(trimmed)) return "Co-Insurance";
  if (/^coinsurance$/i.test(trimmed)) return "Coinsurance";
  return "";
}

function valuesFor(entries: MedicareDetailEntry[], label: string): string[] {
  return entries.filter((entry) => entry.label === label).map((entry) => entry.value).filter(Boolean);
}

function firstValue(entries: MedicareDetailEntry[], label: string): string {
  return valuesFor(entries, label)[0] || "";
}

function pickCoveragePlanDate(values: string[]): string {
  return values[0] || "";
}

function extractDeductibleSummary(bodyText: string): {
  medicareBYearlyDeductible: number | null;
  medicareBDeductibleRemaining: number | null;
} {
  const normalizedBody = bodyText.replace(/\u00A0/g, " ");
  const byLabel = {
    medicareBYearlyDeductible: extractMedicareBAmountAfterLabel(normalizedBody, "Yearly Deductible"),
    medicareBDeductibleRemaining: extractMedicareBAmountAfterLabel(normalizedBody, "Deductible Remaining"),
  };

  if (byLabel.medicareBYearlyDeductible != null || byLabel.medicareBDeductibleRemaining != null) {
    return byLabel;
  }

  const lines = splitLines(normalizedBody);
  const yearlyValues = collectCurrencyValuesAfterLine(lines, "Yearly Deductible");
  const remainingValues = collectCurrencyValuesAfterLine(lines, "Deductible Remaining");
  if (yearlyValues.length > 0 || remainingValues.length > 0) {
    return {
      medicareBYearlyDeductible: yearlyValues[1] ?? yearlyValues[0] ?? null,
      medicareBDeductibleRemaining: remainingValues[1] ?? remainingValues[0] ?? null,
    };
  }

  return {
    medicareBYearlyDeductible: null,
    medicareBDeductibleRemaining: null,
  };
}

function extractMedicareBAmountAfterLabel(bodyText: string, label: string): number | null {
  const escapedLabel = escapeRegExp(label);
  const labelRegex = new RegExp(escapedLabel, "ig");
  const matches = Array.from(bodyText.matchAll(labelRegex));
  let best: number | null = null;

  for (const match of matches) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    const window = bodyText.slice(start, start + 2000);
    const amounts = Array.from(window.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)).map((entry) => Number(entry[1].replace(/,/g, "")));
    if (amounts.length >= 2 && Number.isFinite(amounts[1])) {
      best = amounts[1];
    } else if (best == null && amounts.length >= 1 && Number.isFinite(amounts[0])) {
      best = amounts[0];
    }
  }

  return best;
}

function collectCurrencyValuesAfterLine(lines: string[], label: string): number[] {
  const index = lines.findIndex((line) => normalizeText(line) === normalizeText(label));
  if (index < 0) return [];
  const values: number[] = [];
  for (let cursor = index + 1; cursor < Math.min(lines.length, index + 12); cursor += 1) {
    const parsed = extractCurrency(lines[cursor] || "");
    if (parsed != null) values.push(parsed);
    if (values.length >= 2) break;
  }
  return values;
}

function extractCurrency(value: string): number | null {
  const match = value.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function findLineIndex(lines: string[], target: string, fromIndex: number): number {
  const normalizedTarget = normalizeText(target);
  if (!normalizedTarget) return -1;
  for (let index = fromIndex; index < lines.length; index += 1) {
    if (normalizeText(lines[index] || "") === normalizedTarget) {
      return index;
    }
  }
  return -1;
}

function equalsText(left: string, right: string): boolean {
  return normalizeText(left) === normalizeText(right);
}

function isStatusLine(value: string): boolean {
  return /^(active coverage|inactive coverage|active|inactive|eligible|not eligible)$/i.test(value.trim());
}

function extractStatusHints(bodyText: string): string[] {
  const hints: string[] = [];
  const normalized = bodyText.toLowerCase();
  if (normalized.includes("active coverage")) hints.push("Active Coverage");
  if (normalized.includes("inactive coverage")) hints.push("Inactive Coverage");
  if (normalized.includes("not eligible")) hints.push("Not Eligible");
  if (normalized.includes("eligible")) hints.push("Eligible");
  return hints;
}

function toCoverageStatus(values: string[]): "active" | "inactive" | "unknown" | "error" {
  const normalized = values.map((value) => value.toLowerCase());
  if (normalized.some((value) => value.includes("error"))) return "error";
  if (normalized.some((value) => value.includes("inactive") || value.includes("not active") || value.includes("not eligible"))) return "inactive";
  if (normalized.some((value) => value.includes("active") || value.includes("eligible"))) return "active";
  return "unknown";
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}
