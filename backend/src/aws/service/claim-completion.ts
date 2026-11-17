import type { ServiceRowStatus } from "./service-contract";

type Detail = Record<string, unknown>;
type Outcome = { status: ServiceRowStatus; reason: string };
const BOT_COLUMNS = ["Bot Status", "BotStatus", "bot_status", "bot_overall_result"];
const RESULT_PORTALS = new Set(["aerial", "all-care", "astrona"]);
const FINAL_ONLY_PORTALS = new Set(["medpoint", "regal"]);
const NO_MATCH = /\b(?:no[ _-]?(?:matching|data|results?|claims?|match|patients?|members?)\b|not[ _-]?found\b)/i;
const FAILURE = /\b(?:error|failed|failure|invalid|skipped|timeout|timed out|missing|unavailable|expired|stopped|cancelled|canceled|not accepted)\b/i;
const ACTION = /\b(?:otp|mfa|captcha|verification required|action required|review required)\b/i;
const SUCCESS = /^(?:success|successful|succeeded|completed|complete|done|ok)$/i;

// Also used by PostgreSQL to detect already-frozen false successes. Keep this
// pattern compatible with PostgreSQL ARE; do not add JS-specific lookarounds.
export const UNFINISHED_WORKER_PATTERN = "^\\s*(not[ _-]*(processed|started|checked)|unprocessed|incomplete)([ .:_-].*)?\\s*$";
const HARD_UNFINISHED = new RegExp(UNFINISHED_WORKER_PATTERN, "i");
const PLACEHOLDER = /^(?:|[-–—]+|n\/?a|null|undefined)$/i;
const ACTIVE = /^(?:pending|queued|running|processing|in[ _-]?progress|waiting(?:[ _-].*)?|ready|started|to be processed)$/i;
const scalar = (value: unknown) => value == null ? "" : String(value).trim();
const present = (value: unknown) => !PLACEHOLDER.test(scalar(value));

function ownField(row: Detail, fields: string[]): { found: boolean; value: string } {
  const header = fields.find(field => Object.hasOwn(row, field));
  return { found: header !== undefined, value: header ? scalar(row[header]) : "" };
}

/** Only native worker-owned columns can establish completion. Source claim
 * status, canonical fields and arbitrary notes are not completion evidence. */
export function claimWorkerStatusFields(portal: string): string[] {
  return portal === "availity" ? ["bot_overall_result"]
    : portal === "iehp" ? ["BotClaimStatusCheck"]
      : portal === "waystar" ? ["status", ...BOT_COLUMNS]
        : portal === "uhc" ? ["BotStatus", ...BOT_COLUMNS.filter(field => field !== "BotStatus")]
        : RESULT_PORTALS.has(portal) ? ["result", "Result", ...BOT_COLUMNS] : BOT_COLUMNS;
}

export function classifyClaimCompletion(portal: string, row: Detail): Outcome {
  const processing = ownField(row, claimWorkerStatusFields(portal));
  const notes = ownField(row, portal === "iehp" ? ["BotClaimStatusCheckError"]
    : portal === "availity" ? ["bot_notes"]
      : portal === "waystar" ? ["Remarks", "bot_notes", "Bot Message"]
        : ["Bot Message", "BotStatusError", "bot_notes", "notes", "error_message"]).value;
  let raw = processing.value;
  if (!processing.found && FINAL_ONLY_PORTALS.has(portal)) {
    raw = ownField(row, ["final_status", "Final Status"]).value;
  }
  const incomplete: Outcome = { status: "INCOMPLETE", reason: "" };
  if (HARD_UNFINISHED.test(raw)) return incomplete;

  // Waystar writes this explicit, completed missing-EOB outcome as NA. NA by
  // itself remains a placeholder, rather than a successful claim result.
  if (portal === "waystar" && /^n\/?a$/i.test(raw) && /eob was not in the waystar portal/i.test(notes)) {
    return { status: "NO_MATCH", reason: notes };
  }
  if (PLACEHOLDER.test(raw)) return incomplete;
  if (SUCCESS.test(raw)) return { status: "SUCCESS", reason: "" };

  // These portals encode adjudication in their worker-owned status column.
  // A claim pending with the payer is different from an unprocessed lookup.
  if (portal === "blue-shield" && /^(?:paid|denied|claim pending)$/i.test(raw)) return { status: "SUCCESS", reason: "" };
  if (portal === "waystar" && /^(?:paid|denial|denied|calling)$/i.test(raw)) return { status: "SUCCESS", reason: "" };
  if (portal === "optum-pro" && /in\s*(?:process|progress)/i.test(raw) && ["Search Result Claim Number", "Claim Number"].some(field => present(row[field]))) {
    return { status: "SUCCESS", reason: "" };
  }
  if (!processing.found && FINAL_ONLY_PORTALS.has(portal)) {
    if (ACTION.test(raw)) return { status: "ACTION_REQUIRED", reason: notes || raw };
    if (FAILURE.test(raw)) return { status: "FAILED", reason: notes || raw };
    if (NO_MATCH.test(raw)) return { status: "NO_MATCH", reason: raw };
    const foundClaim = Number(row.search_result_index) > 0 || ["portal_claim_number", "search_claim_number"].some(field => present(row[field]));
    if (foundClaim) return { status: "SUCCESS", reason: "" };
    return incomplete;
  }
  if (ACTIVE.test(raw)) return incomplete;
  if (ACTION.test(raw)) return { status: "ACTION_REQUIRED", reason: notes || raw };
  if (/^(?:no member id(?: found)?|no payer\/group found)$/i.test(raw)) return { status: "FAILED", reason: notes || raw };
  if (NO_MATCH.test(raw)) return { status: "NO_MATCH", reason: notes || raw };
  if (FAILURE.test(raw) || /^claim details unavailable$/i.test(raw)) {
    if (ACTION.test(notes)) return { status: "ACTION_REQUIRED", reason: notes || raw };
    if (NO_MATCH.test(notes)) return { status: "NO_MATCH", reason: notes || raw };
    return { status: "FAILED", reason: notes || raw };
  }
  // Fail closed on new/unrecognized statuses. A nonempty cell is not success.
  return incomplete;
}

