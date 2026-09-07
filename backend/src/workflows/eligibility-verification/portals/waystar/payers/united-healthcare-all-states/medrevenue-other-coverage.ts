import type { EligibilityResult } from "../../../../types";

export type UhcOtherCoverageBlock = { payer: string; cobDate: string; serviceType: string };

/** Runs in the response document. Keep each payer's dates and services together. */
export function extractMedRevenueUhcOtherCoverage(): UhcOtherCoverageBlock[] {
  const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const containers = Array.from(document.querySelectorAll(".ContentContainer"))
    .filter((container) => Array.from(container.querySelectorAll("h4")).some((heading) => text(heading).toLowerCase() === "other coverage information"));
  return containers.flatMap((container) => Array.from(container.querySelectorAll(".HalfColumn"))).map((block) => {
    const read = (label: string) => {
      const element = Array.from(block.querySelectorAll(".Label")).find((candidate) => text(candidate).replace(/:$/, "").toLowerCase() === label);
      // Service Type is a direct Label/Text sibling pair, outside a .Row.
      const value = element?.nextElementSibling;
      return value?.classList.contains("Text") ? text(value) : "";
    };
    return { payer: read("payer"), cobDate: read("cob date"), serviceType: read("service type") };
  }).filter((block) => Boolean(block.cobDate || block.serviceType));
}

export function applyMedRevenueUhcOtherCoverage(result: EligibilityResult): EligibilityResult {
  const response = result.metadata?.fullPayerResponse as { uhcOtherCoveragePayerBlocks?: UhcOtherCoverageBlock[] } | undefined;
  const blocks = response?.uhcOtherCoveragePayerBlocks ?? [];
  const block = blocks.find((candidate) => candidate.payer && candidate.cobDate)
    ?? blocks.find((candidate) => candidate.cobDate);
  // Prefer the COB block's service when available. Otherwise retain services
  // from Other Coverage, including vendor-only blocks with no COB Date.
  const serviceType = block?.serviceType || [...new Set(blocks.map((candidate) => candidate.serviceType).filter(Boolean))].join("; ");
  return {
    ...result,
    planDate: block?.cobDate || undefined,
    metadata: { ...result.metadata, medRevenueOutputServiceType: serviceType },
  };
}
