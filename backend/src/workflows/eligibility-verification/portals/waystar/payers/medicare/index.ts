import type { WaystarPayerHandler } from "../types";

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
    const statuses = [result.overallStatus, ...result.sectionStatuses.map((entry) => entry.status)];
    const coverageStatus = toCoverageStatus(statuses);

    return {
      rowIndex: row.originalIndex,
      payerId: "medicare",
      coverageStatus,
      planName: result.sectionStatuses.map((entry) => entry.title).filter(Boolean).join(", ") || "Medicare",
      benefits: result.sectionStatuses.map((entry) => ({
        serviceType: entry.title || "General Coverage",
        coverageStatus: toCoverageStatus([entry.status]),
        notes: entry.status || undefined,
      })),
      metadata: {
        overallStatus: result.overallStatus,
        sections: result.sectionStatuses,
      },
    };
  },
};

function asMedicarePayload(payload: unknown): {
  overallStatus: string;
  sectionStatuses: Array<{ title: string; status: string }>;
} {
  if (!payload || typeof payload !== "object") {
    return { overallStatus: "", sectionStatuses: [] };
  }

  const record = payload as {
    overallStatus?: unknown;
    sectionStatuses?: unknown;
  };

  return {
    overallStatus: asText(record.overallStatus),
    sectionStatuses: Array.isArray(record.sectionStatuses)
      ? record.sectionStatuses.map((entry) => {
        const section = entry as { title?: unknown; status?: unknown };
        return {
          title: asText(section.title),
          status: asText(section.status),
        };
      })
      : [],
  };
}

function toCoverageStatus(values: string[]): "active" | "inactive" | "unknown" | "error" {
  const normalized = values.map((value) => value.toLowerCase());
  if (normalized.some((value) => value.includes("error"))) return "error";
  if (normalized.some((value) => value.includes("active"))) return "active";
  if (normalized.some((value) => value.includes("inactive") || value.includes("not active"))) return "inactive";
  return "unknown";
}

function asText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}
