import type { Frame, Page, Request, Response } from 'playwright-core';
import type { AutomationContext } from '../../../types';

export function authenticationErrorCodes(body: string): string[] {
  // Return only recognized protocol categories, never server messages or data.
  const allowed = ['INVALID_REQUEST', 'INVALID_VALUE', 'INVALID_TOKEN', 'EXPIRED_TOKEN', 'INVALID_SESSION', 'SESSION_EXPIRED', 'ACCESS_DENIED', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_CREDENTIALS', 'INVALID_CLIENT', 'INVALID_GRANT', 'UNSUPPORTED_GRANT_TYPE', 'REQUEST_FAILED', 'VALIDATION_ERROR'];
  const words = new Set(body.toUpperCase().match(/[A-Z][A-Z_]+/g) || []);
  return allowed.filter(code => words.has(code));
}

// Do not serialize URLs: SSO query strings AND path segments contain tokens.
export function loginDestination(raw: string) {
  try {
    const url = new URL(raw);
    const stage = /authorization\.ping/.test(url.pathname) ? 'sso-resume'
      : /authorization\.oauth2/.test(url.pathname) ? 'sso-authorize'
      : /login\/oauth2\/code/.test(url.pathname) ? 'portal-callback'
      : /careconnect/.test(url.pathname) ? 'portal'
      : 'other';
    return { host: url.hostname, stage,
      authenticationDenied: url.searchParams.get('error') === 'access_denied'
        || /authentication[ +]failed/i.test(url.searchParams.get('error_description') || '') };
  } catch { return { host: '', stage: 'unavailable', authenticationDenied: false }; }
}

export function startHealthNetLoginDiagnostics(page: Page) {
  const started = Date.now();
  const events: Array<Record<string, unknown>> = [];
  let dropped = 0;
  let stopped = false;
  const pending = new Set<Promise<void>>();
  const record = (event: Record<string, unknown>) => {
    if (events.length >= 500) { dropped++; return; }
    events.push({ elapsedMs: Date.now() - started, ...event });
  };
  const navigation = (frame: Frame) => {
    record({ type: 'navigation', mainFrame: frame === page.mainFrame(), ...loginDestination(frame.url()) });
  };
  const response = (result: Response) => {
    if (result.request().isNavigationRequest() || result.status() >= 400) {
      record({ type: 'response', status: result.status(), resourceType: result.request().resourceType(), ...loginDestination(result.url()) });
    }
    if (result.status() >= 400 && new URL(result.url()).hostname === 'auth.entrykeyid.com') {
      const capture = result.text().then(body => {
        record({ type: 'authentication-error-codes', status: result.status(), codes: authenticationErrorCodes(body) });
      }).catch(() => { record({ type: 'authentication-error-body-unavailable' }); });
      pending.add(capture);
      void capture.finally(() => pending.delete(capture));
    }
  };
  const failed = (request: Request) => {
    // Record only known network error categories, never arbitrary failure text.
    const reason = request.failure()?.errorText || '';
    const code = ['ERR_ABORTED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_BLOCKED_BY_CLIENT']
      .find(value => reason.includes(value)) || 'OTHER_NETWORK_FAILURE';
    record({ type: 'request-failed', code, resourceType: request.resourceType(), ...loginDestination(request.url()) });
  };
  const crash = () => record({ type: 'page-crashed' });
  const closed = () => record({ type: 'page-closed' });
  page.on('framenavigated', navigation);
  page.on('response', response);
  page.on('requestfailed', failed);
  page.on('crash', crash);
  page.on('close', closed);

  return {
    async finish(context: AutomationContext, outcome: 'success' | 'failure', error?: unknown) {
      if (stopped) return;
      stopped = true;
      page.off('framenavigated', navigation);
      page.off('response', response);
      page.off('requestfailed', failed);
      page.off('crash', crash);
      page.off('close', closed);
      let captureTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => { captureTimer = setTimeout(resolve, 3000); })]);
      } finally { clearTimeout(captureTimer); }
      const screens = await Promise.all(page.frames().map(async frame => ({
        destination: loginDestination(frame.url()), mainFrame: frame === page.mainFrame(),
        controls: await frame.evaluate(() => ({
          username: !!document.querySelector('#username'), password: !!document.querySelector('#password'),
          sendCode: !!document.querySelector('#continueMfa'),
          otp: !!document.querySelector('input[autocomplete="one-time-code"]'),
          eligibilitySearch: !!document.querySelector('input[name="memberIdOrLastName"]'),
          radioCount: document.querySelectorAll('input[type="radio"], [role="radio"]').length,
          readyState: document.readyState,
        })).catch(() => null),
      })));
      const report = { outcome, durationMs: Date.now() - started,
        failureCategory: outcome === 'success' ? undefined : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'login-failure',
        events, droppedEvents: dropped, screens };
      const denied = events.some(event => event.authenticationDenied === true);
      await context.log({ level: outcome === 'success' ? 'info' : 'error', eventName: 'eligibility_healthnet_login_diagnostics',
        message: `Health Net login ${outcome}. Recorded ${events.filter(event => event.type === 'navigation').length} navigations and ${events.filter(event => event.type === 'request-failed').length} failed requests.${denied ? ' The SSO service returned authentication denied.' : ''} Download the login diagnostics for details.` });
      await context.emit({ type: 'file_download', filename: 'healthnet-login-diagnostics.json', mimeType: 'application/json', base64: Buffer.from(JSON.stringify(report, null, 2)).toString('base64') });
      if (outcome === 'failure' && !page.isClosed()) {
        const masks = page.frames().map(frame => frame.locator('input, textarea, [contenteditable="true"]'));
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 80, mask: masks, timeout: 10_000 }).catch(() => null);
        if (screenshot) await context.emit({ type: 'error_screenshot', index: 0, filename: 'healthnet-login-failure.jpg', image: screenshot.toString('base64'), mimeType: 'image/jpeg' });
      }
    },
  };
}
