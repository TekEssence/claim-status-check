/** Written by workers. Adjudication (Paid/Denied/Pending) is never an outcome. */
export const WORKER_OUTCOME_COLUMN = "Worker Outcome";
export const WORKER_OUTCOMES = ["SUCCESS", "NO_MATCH", "FAILED", "SKIPPED", "ACTION_REQUIRED", "INCOMPLETE"] as const;
export type WorkerOutcome = typeof WORKER_OUTCOMES[number];

// Adapter metadata, not separate completion rules. Only this worker-generated
// execution column is read; similarly named submitted columns are ignored.
const EXECUTION_COLUMNS: Record<string, string> = {
  availity: "bot_overall_result", iehp: "BotClaimStatusCheck", uhc: "BotStatus",
  aerial: "result", "all-care": "result", astrona: "result",
  "blue-shield": WORKER_OUTCOME_COLUMN, cigna: "Bot Status", kaiser: "Bot Status",
  "my-family": "Bot Status", "optum-pro": "Bot Status", physicians: "Bot Status",
  medpoint: "BotStatus", regal: "BotStatus", waystar: WORKER_OUTCOME_COLUMN,
};

export function isWorkerOutcome(value: unknown): value is WorkerOutcome {
  return typeof value === "string" && WORKER_OUTCOMES.some(status => status === value);
}

/** Native execution codes only. Unknown codes fail closed. */
export function workerExecutionOutcome(value: unknown): WorkerOutcome {
  const raw = String(value ?? "").trim().replace(/[_-]+/g, " ");
  if (/^(?:not (?:processed|started|checked)|unprocessed|incomplete|pending|queued|running|processing|in progress|waiting)(?:[ .:].*)?$/i.test(raw)) return "INCOMPLETE";
  if (/^(success|successful|succeeded|completed|complete|done|ok)$/i.test(raw)) return "SUCCESS";
  if (/^skipped(?:[ .:].*)?$/i.test(raw)) return "SKIPPED";
  if (/^(action required|manual action required|review required|otp required|mfa required|captcha required)$/i.test(raw)) return "ACTION_REQUIRED";
  if (/^(no member id(?: found)?|no payer\/group found)$/i.test(raw)) return "FAILED";
  if (/^(?:member id option not found)$/i.test(raw)) return "FAILED";
  if (/^(?:cpt not found in procedures|cpt\/service dates not found in services)$/i.test(raw)) return "NO_MATCH";
  if (/^(no (?:matching |matched )?(?:claims?|data|results?|patients?|members?|cpt\/service code)(?: found)?|(?:member |patient |claim |services? )?not found|no match)$/i.test(raw)) return "NO_MATCH";
  if (/\b(error|failed|failure|invalid|skipped|timeout|timed out|missing|unavailable|expired|stopped|cancelled|canceled|not accepted)\b/i.test(raw)) return "FAILED";
  return "INCOMPLETE";
}

/** Called while building worker output, never by the service API. */
export function workerOutcomeForOutput(portal: string, row: Record<string, unknown>): WorkerOutcome {
  const field = EXECUTION_COLUMNS[portal];
  if (!field) throw new Error("Worker execution column is not registered.");
  if (field === WORKER_OUTCOME_COLUMN) return isWorkerOutcome(row[field]) ? row[field] : "INCOMPLETE";
  return workerExecutionOutcome(row[field]);
}
