type JobEvent = { type?: unknown; message?: unknown; inputName?: unknown };

export function isJobInputRequest(event: JobEvent): boolean {
  return ["input_request", "otp_request", "otp_required", "provider_options"].includes(String(event.type));
}

export function jobEventLog(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const event = payload as JobEvent;
  if (typeof event.message === "string" && event.message.trim()) return event.message.trim();
  if (event.type === "input_submitted") return "Verification response submitted. Waiting for worker acknowledgement.";
  if (event.type === "input_consumed") return "Verification response received by worker. Processing resumed.";
  return "";
}

export function mergeJobLogs(events: Array<{ payload?: unknown }>, cloudWatchLogs: string[] = []): string[] {
  const saved = events.map(event => jobEventLog(event.payload)).filter(Boolean);
  // Preserve repeated stage messages within event history; add only missing CloudWatch messages.
  const known = new Set(saved);
  return [...saved, ...cloudWatchLogs.filter(line => {
    if (!line.trim() || known.has(line)) return false;
    known.add(line);
    return true;
  })];
}
