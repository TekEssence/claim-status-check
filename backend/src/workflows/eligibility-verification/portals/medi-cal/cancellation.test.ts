import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { watchMediCalCancellation } from './cancellation';

test('Medi-Cal cancellation interrupts an idle login wait and closes the portal', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext();
  let cancelled = false;
  const stop = watchMediCalCancellation(context, () => cancelled);
  try {
    const page = await context.newPage();
    await page.setContent('<input placeholder="Email Address">');
    const waiting = page.locator('input[type=password]').waitFor({ timeout: 60_000 });
    const interrupted = assert.rejects(waiting, /closed/i);
    const started = Date.now();
    cancelled = true;
    await interrupted;
    assert.ok(Date.now() - started < 5000, 'Cancellation should interrupt the wait promptly');
    assert.equal(page.isClosed(), true);
  } finally { stop(); await browser.close(); }
});
