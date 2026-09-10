import { runStalledJobWatchdog } from "../runtime/job-watchdog";

export async function handler() {
  const result = await runStalledJobWatchdog();
  console.log("Stalled job watchdog completed", result);
  return result;
}
