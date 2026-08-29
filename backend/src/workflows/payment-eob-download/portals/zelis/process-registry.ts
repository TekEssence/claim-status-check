export type ZelisProcessId = "charm" | "medrevenue";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function resolveZelisProcess(project: string): ZelisProcessId {
  const normalized = normalize(project);
  if (!normalized || normalized === "charm") return "charm";
  if (normalized === "medrevenue" || normalized === "medrev") return "medrevenue";
  throw new Error(`Unsupported Zelis Project "${project}". Supported projects: CHARM and MedRevenue.`);
}

export function isMedRevenuePendingEftRow(row: { entryStatus?: string; modeOfPayment?: string }): boolean {
  return normalize(row.entryStatus || "") === "pending" && normalize(row.modeOfPayment || "") === "eft";
}
