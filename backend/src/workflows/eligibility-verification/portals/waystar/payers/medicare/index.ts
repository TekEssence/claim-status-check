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
    const sections = result.sectionStatuses.length > 0 ? result.sectionStatuses : extractSectionsFromBody(result.bodyText);
    const statuses = [
      result.overallStatus,
      ...sections.map((entry) => entry.status),
      ...extractStatusHints(result.bodyText),
    ].filter(Boolean);
    const coverageStatus = toCoverageStatus(statuses);
    const planName = sections.map((entry) => entry.title).filter(Boolean).join(", ") || "Medicare";
    const benefits = sections.length > 0
      ? sections.map((entry) => ({
        serviceType: entry.title || "General Coverage",
        coverageStatus: toCoverageStatus([entry.status, result.bodyText]),
        notes: entry.status || undefined,
      }))
      : [
        {
          serviceType: "30 - Health Benefit Plan Coverage",
          coverageStatus,
          notes: statuses.join(" | ") || undefined,
        },
      ];

    return {
      rowIndex: row.originalIndex,
      payerId: "medicare",
      coverageStatus,
      planName,
      benefits,
      metadata: {
        overallStatus: result.overallStatus,
        sections,
        bodyText: result.bodyText,
      },
    };
  },
};

function asMedicarePayload(payload: unknown): {
  overallStatus: string;
  sectionStatuses: Array<{ title: string; status: string }>;
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
        const section = entry as { title?: unknown; status?: unknown };
        return {
          title: asText(section.title),
          status: asText(section.status),
        };
      })
      : [],
    bodyText: asText(record.bodyText),
  };
}

function extractSectionsFromBody(bodyText: string): Array<{ title: string; status: string }> {
  const matches = Array.from(
    bodyText.matchAll(/(Medicare\s+Part\s+[AB])([\s\S]{0,120}?)(Active Coverage|Inactive Coverage|Active|Inactive|Eligible|Not Eligible)/gi),
  );

  return matches.map((match) => ({
    title: match[1]?.trim() || "Medicare",
    status: match[3]?.trim() || "",
  }));
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

function asText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}
