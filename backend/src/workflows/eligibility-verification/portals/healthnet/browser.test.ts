import assert from 'node:assert/strict';
import test from 'node:test';
import { launchHealthNetBrowser } from './browser';

test('Health Net uses native Chrome identity and a fresh context', async () => {
  const previous = process.env.BROWSER_HEADLESS;
  process.env.BROWSER_HEADLESS = 'true';
  try {
    const launched = await launchHealthNetBrowser();
    try {
      assert.ok(launched.browser);
      const page = await launched.context.newPage();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const major = launched.browser.version().split('.')[0];
      assert.match(userAgent, new RegExp(`(?:HeadlessChrome|Chrome)/${major}\\.`));
      assert.deepEqual(await launched.context.cookies(), []);
    } finally { await launched.browser?.close(); }
  } finally {
    if (previous === undefined) delete process.env.BROWSER_HEADLESS;
    else process.env.BROWSER_HEADLESS = previous;
  }
});
