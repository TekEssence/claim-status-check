/** Shared by deployed manual jobs and service jobs. No credential/input values are retained. */
export function isPersistentWorkflowEvent(data: Record<string, unknown>): boolean {
  return ["job_started", "task_starting", "progress", "row_progress", "log", "warning", "error",
    "input_request", "otp_request", "provider_options", "input_submitted", "input_consumed",
    "cancellation_acknowledged", "cancelled", "completed", "partial_success", "failed", "output_ready"]
    .includes(String(data.type ?? ""));
}

export function persistentWorkflowEventType(data: Record<string, unknown>): string {
  return data.type === "otp_request" || data.type === "provider_options" ? "input_request" : String(data.type ?? "event");
}

export function isInputRequest(data: Record<string, unknown>): boolean {
  return data.type === "input_request" || data.type === "otp_request" || data.type === "provider_options";
}

export function persistentWorkflowEventPayload(data: Record<string, unknown>): Record<string, unknown> {
  if (data.type === "progress" || data.type === "row_progress") {
    const payload: Record<string, unknown> = { type: data.type };
    for (const name of ["completed", "total", "currentRow", "current"]) {
      if (typeof data[name] === "number") payload[name] = data[name];
    }
    return payload;
  }
  const payload = { ...data };
  for (const name of ["value", "otp", "secret", "password"]) delete payload[name];
  return payload;
}
