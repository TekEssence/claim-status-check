import type { Locator } from "playwright-core";
import { parseWebsiteMmDdYyyy } from "./claims/dates";

export type ClaimDetailLineCandidate = {
  fromDate: string;
  toDate: string;
  procedure: string;
  modifier: string;
  quantity: string;
  billed: string;
  status: string;
  raw: string;
  distance: number;
  exactDos: boolean;
  cptMatches: boolean;
  modifierMatches: boolean;
};

export type ExpandedClaimRowInspection = {
  summaryText: string;
  headerText: string;
  statusInfoText: string;
  fullDetailsText: string;
  exactMatch: ClaimDetailLineCandidate | null;
  nearestCandidates: ClaimDetailLineCandidate[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeClaimProcedure(value: string): string {
  return value.replace(/\s+/g, "").trim().toUpperCase();
}

function procedureMatchesClaim(detailProcedure: string, claimCpt: string): boolean {
  if (!claimCpt) return true;
  const normalizedClaimCpt = normalizeClaimProcedure(claimCpt);
  const normalizedDetailProcedure = normalizeClaimProcedure(detailProcedure);
  if (!normalizedClaimCpt || !normalizedDetailProcedure) return false;
  return new RegExp(`(?:^|\\D)${escapeRegExp(normalizedClaimCpt)}(?:\\D|$)`, "i").test(` ${normalizedDetailProcedure} `);
}

export function buildExpandedDetailSummary(matchedLine: ClaimDetailLineCandidate, originalSummaryText: string): string {
  return [
    `DOS: ${matchedLine.fromDate}`,
    `Service Date: ${matchedLine.toDate}`,
    matchedLine.billed ? `Billed Amount: ${matchedLine.billed}` : "",
    matchedLine.procedure ? `Procedure: ${matchedLine.procedure}` : "",
    matchedLine.modifier ? `Modifier: ${matchedLine.modifier}` : "",
    matchedLine.quantity ? `Quantity: ${matchedLine.quantity}` : "",
    matchedLine.status ? `Status: ${matchedLine.status}` : "",
    `Original Summary: ${originalSummaryText}`,
  ].filter(Boolean).join(" | ");
}

export function formatNearestDosCandidates(candidates: ClaimDetailLineCandidate[]): string {
  return candidates
    .map((candidate) => {
      const modifierText = candidate.modifier ? ` | Modifier ${candidate.modifier}` : "";
      return `${candidate.fromDate} - ${candidate.toDate} | Proc ${candidate.procedure}${modifierText}`;
    })
    .join(", ");
}

function parseFromToRange(text: string): { fromDate: string; toDate: string } | null {
  const match = text.match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/);
  if (!match) return null;
  return { fromDate: match[1], toDate: match[2] };
}

function normalizeDetailModifierTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
}

function getDateDistanceFromRange(targetDate: Date, fromDateText: string, toDateText: string): number {
  const fromDate = parseWebsiteMmDdYyyy(fromDateText);
  const toDate = parseWebsiteMmDdYyyy(toDateText);
  if (!fromDate || !toDate) return Number.POSITIVE_INFINITY;

  const targetTime = targetDate.getTime();
  const fromTime = fromDate.getTime();
  const toTime = toDate.getTime();

  if (targetTime >= fromTime && targetTime <= toTime) {
    return 0;
  }

  return Math.min(Math.abs(targetTime - fromTime), Math.abs(targetTime - toTime));
}

export function uniqueNearestDetailCandidates(candidates: ClaimDetailLineCandidate[], limit = 3): ClaimDetailLineCandidate[] {
  const seen = new Set<string>();
  const sorted = [...candidates].sort((a, b) => a.distance - b.distance || a.raw.localeCompare(b.raw));
  const unique: ClaimDetailLineCandidate[] = [];

  for (const candidate of sorted) {
    const key = `${candidate.fromDate}|${candidate.toDate}|${candidate.procedure}|${candidate.modifier}|${candidate.billed}|${candidate.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= limit) break;
  }

  return unique;
}

export async function inspectExpandedClaimRow(
  currentLineItem: Locator,
  dosDate: Date,
  claimCpt: string,
  claimModifiers: string[],
): Promise<ExpandedClaimRowInspection> {
  const summaryText = (await currentLineItem.innerText({ timeout: 5000 })).replace(/\s+/g, " ").trim();
  await currentLineItem.click({ timeout: 5000 });

  const detailsRow = currentLineItem.locator("~ tr.details").first();
  const detailsContent = detailsRow.locator(".details-content");
  await detailsContent.waitFor({ state: "visible", timeout: 10000 });
  const headerText = await detailsContent.locator(".details-header").innerText();
  const tableText = await detailsContent.locator("table.table-condensed").innerText();
  const statusInfoText = tableText.replace(/\s+/g, " ");
  const fullDetailsText = `${headerText} ${statusInfoText}`.replace(/\s+/g, " ");

  const rawRows = await detailsContent.locator("table.table-condensed tbody tr").evaluateAll((rows) =>
    rows.map((row) =>
      Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent || "").replace(/\s+/g, " ").trim()),
    ),
  );

  const detailCandidates: ClaimDetailLineCandidate[] = rawRows
    .map((cells) => {
      if (cells.length < 7) return null;
      const dateRange = parseFromToRange(cells[1] || "");
      if (!dateRange) return null;

      const procedureText = (cells[2] || "").replace(/\s+/g, " ").trim();
      const modifierText = (cells[3] || "").replace(/\s+/g, " ").trim();
      const distance = getDateDistanceFromRange(dosDate, dateRange.fromDate, dateRange.toDate);
      const exactDos = distance === 0;
      const cptMatches = procedureMatchesClaim(procedureText, claimCpt);
      const detailModifierTokens = normalizeDetailModifierTokens(modifierText);
      const modifierMatches =
        claimModifiers.length === 0 || claimModifiers.some((modifier) => detailModifierTokens.includes(modifier.toUpperCase()));

      return {
        fromDate: dateRange.fromDate,
        toDate: dateRange.toDate,
        procedure: procedureText,
        modifier: modifierText,
        quantity: (cells[4] || "").trim(),
        billed: (cells[5] || "").trim(),
        status: (cells[6] || "").trim(),
        raw: cells.join(" | "),
        distance,
        exactDos,
        cptMatches,
        modifierMatches,
      } satisfies ClaimDetailLineCandidate;
    })
    .filter((candidate): candidate is ClaimDetailLineCandidate => candidate !== null);

  const exactDosCandidates = detailCandidates.filter((candidate) => candidate.exactDos);
  const exactCandidates = (claimCpt
    ? exactDosCandidates.filter((candidate) => candidate.cptMatches)
    : exactDosCandidates)
    .sort((a, b) => {
      const scoreA = (a.cptMatches ? 2 : 0) + (a.modifierMatches ? 1 : 0);
      const scoreB = (b.cptMatches ? 2 : 0) + (b.modifierMatches ? 1 : 0);
      return scoreB - scoreA;
    });

  return {
    summaryText,
    headerText,
    statusInfoText,
    fullDetailsText,
    exactMatch: exactCandidates[0] ?? null,
    nearestCandidates: uniqueNearestDetailCandidates(detailCandidates, 3),
  };
}
