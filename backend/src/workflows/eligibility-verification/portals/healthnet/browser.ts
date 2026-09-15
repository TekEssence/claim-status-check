import { launchAutomationBrowser, type BrowserLaunchResult } from '@/backend/src/core/browser';

/** Use the shared browser runtime with a fresh native-UA context for EntryKeyID. */
export async function launchHealthNetBrowser(): Promise<BrowserLaunchResult> {
  const launched = await launchAutomationBrowser();
  if (!launched.browser) {
    await launched.context.close();
    throw new Error('Health Net requires an isolated browser context.');
  }
  try {
    const context = await launched.browser.newContext({ acceptDownloads: true, viewport: { width: 1920, height: 1080 }, locale: 'en-US' });
    await launched.context.close();
    return { browser: launched.browser, context };
  } catch (error) {
    await launched.browser.close();
    throw error;
  }
}
