const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);

let shutdownScheduled = false;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function scheduleTaskShutdownAfterWorkflow(reason: string): void {
  if (!TRUE_VALUES.has(String(process.env.EXIT_AFTER_WORKFLOW_DONE ?? "").trim().toLowerCase())) {
    return;
  }
  if (shutdownScheduled) return;
  shutdownScheduled = true;

  const delayMs = parsePositiveInteger(process.env.EXIT_AFTER_WORKFLOW_DELAY_MS, 15000);
  console.log(`Workflow finished (${reason}). Exiting task in ${delayMs}ms.`);

  setTimeout(() => {
    console.log("Exiting task after workflow completion.");
    process.exit(0);
  }, delayMs).unref();
}
