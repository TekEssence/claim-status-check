import type { Page } from "playwright-core";
import type { AutomationContext } from "../../../../types";
import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import { authenticateAvailityEligibility } from "../authentication";
import type { AvailityEligibilityCredentials } from "../credentials";

export async function authenticateMedRevenueAvaility(
  page: Page, credentials: AvailityEligibilityCredentials, context: AutomationContext,
  waitForInput = waitForScrapeJobInput,
) {
  if (credentials.totpSecret) return authenticateAvailityEligibility(page, credentials);
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded" });
  await page.locator('#userId').fill(credentials.username);
  await page.locator('#password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  const home = page.locator('#patient_registration-menu');
  const codeField = page.locator('input#code, input[name="code"], input[autocomplete="one-time-code"]').filter({ visible: true }).first();
  const method = page.locator("input[name='choice'][value='Authenticate me using my Authenticator app']");
  await home.or(codeField).or(method).first().waitFor({ state: 'visible', timeout: 60_000 });
  if (await home.isVisible()) return;
  if (!await codeField.isVisible()) {
    await method.check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await codeField.waitFor({ state: 'visible', timeout: 30_000 });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (context.isCancelled?.()) throw new Error('Availity verification cancelled.');
    const inputName = `availity_otp_${crypto.randomUUID()}`;
    const timeoutMs = 10 * 60 * 1000;
    await context.emit({ type: 'otp_request', inputName, label: 'Availity verification code',
      message: attempt ? 'Verification did not complete. Enter a fresh Availity code and click Submit code.' : 'Enter your current Availity verification code here, then click Submit code.', timeoutMs });
    const code = (await waitForInput(context.jobId, inputName, timeoutMs)).trim();
    if (context.isCancelled?.()) throw new Error('Availity verification cancelled.');
    if (!/^\d{6}$/.test(code)) continue;
    await codeField.fill('');
    await codeField.pressSequentially(code, { delay: 75 });
    await page.getByRole('button', { name: /^(Continue|Verify|Submit)$/i }).filter({ visible: true }).click();
    if (await home.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)) return;
    if (!await codeField.isVisible()) throw new Error('Availity verification did not reach Patient Registration.');
  }
  throw new Error('Availity verification failed after three code attempts.');
}
