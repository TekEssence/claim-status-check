function createRunId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function createAuditLogEntry({
  runId,
  inputRowId = "",
  subscriberNo = "",
  serviceDate = "",
  step,
  status,
  message = "",
  currentUrl = "",
  startedAt,
}) {
  const now = new Date();
  const durationMs = startedAt ? now.getTime() - startedAt.getTime() : "";

  return {
    run_id: runId,
    timestamp: now.toISOString(),
    input_row_id: inputRowId,
    subscriber_no: subscriberNo,
    service_date: serviceDate,
    step,
    status,
    duration_ms: durationMs,
    message,
    current_url: currentUrl,
  };
}

function createErrorLogEntry({
  runId,
  inputRowId = "",
  subscriberNo = "",
  serviceDate = "",
  failureStage,
  failureReason,
  humanMessage,
  currentUrl = "",
  snapshotPath = "",
  needsManualReview = true,
}) {
  return {
    run_id: runId,
    timestamp: new Date().toISOString(),
    input_row_id: inputRowId,
    subscriber_no: subscriberNo,
    service_date: serviceDate,
    failure_stage: failureStage,
    failure_reason: failureReason,
    human_message: humanMessage,
    current_url: currentUrl,
    snapshot_path: snapshotPath,
    needs_manual_review: needsManualReview ? "yes" : "no",
  };
}

module.exports = {
  createRunId,
  createAuditLogEntry,
  createErrorLogEntry,
};
