type InputCommand = { commandType: string; payload: unknown };

/** Resolve only the requested waiter. Historical aliases are used only for legacy "otp" commands. */
export function deliverWorkerInput(
  jobId: string, command: InputCommand,
  submit: (jobId: string, inputName: string, value: string) => boolean,
): boolean {
  const payload = command.payload as { value?: unknown } | null;
  if (typeof payload?.value !== "string" || !payload.value.trim()) return false;
  const value = payload.value.trim();
  const names = command.commandType === "otp" ? ["otp", "regalOtp"] : [command.commandType];
  return names.some(name => submit(jobId, name, value));
}
