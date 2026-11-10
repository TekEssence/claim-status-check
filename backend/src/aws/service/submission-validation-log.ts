import type { ServiceSubmitBody } from './service-contract';

/** Keep validation field names/row numbers, never the submitted payload or stack. */
export function submissionValidationLog(error: unknown, body: ServiceSubmitBody, clientSystem: string, clientExecutionId: string) {
  let reason = error instanceof Error ? error.message : 'Invalid portal claim input.';
  // Existing readers sometimes interpolate account/group/project values in quotes.
  reason = reason.replace(/"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`/g, '[redacted]')
    .replace(/Duplicate client_row_ref:.*/i, 'Duplicate client_row_ref: [redacted].');
  const secrets: string[] = [];
  const collectSecrets = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 3) secrets.push(value);
    else if (Array.isArray(value)) value.forEach(collectSecrets);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectSecrets);
  };
  collectSecrets(body.credentials);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) reason = reason.split(secret).join('[redacted]');
  return {
    event: 'service_submission_validation_failed',
    statusCode: 422,
    stage: 'portal_input_preparation',
    client_system: clientSystem,
    client_execution_id: clientExecutionId,
    workflow: typeof body.workflow === 'string' ? body.workflow.slice(0, 80) : null,
    portal: typeof body.portal === 'string' ? body.portal.slice(0, 80) : null,
    claim_count: Array.isArray(body.claims) ? body.claims.length : null,
    reason: reason.replace(/[\r\n\t]/g, ' ').slice(0, 2000),
  };
}
