import type { Page } from "playwright-core";

function isRetryableClaimStatusNavigationError(error: unknown, claimStatusUrl: string): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /page\.goto: Timeout/i.test(message) &&
    message.includes(claimStatusUrl)
  ) || /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_TIMED_OUT|Navigation failed because page crashed/i.test(message);
}

export async function navigateToClaimStatusWithRetry(
  page: Page,
  claimStatusUrl: string,
  rowNumber: number,
  log: (message: string) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await log(`Row ${rowNumber}: Navigating to Claims Status...`);
      await page.goto(claimStatusUrl, {
        waitUntil: "networkidle",
        timeout: 60000,
      });
      return;
    } catch (error) {
      if (attempt < 2 && isRetryableClaimStatusNavigationError(error, claimStatusUrl)) {
        await log(`Row ${rowNumber}: Claims Status navigation failed due to network/timeout. Retrying same claim (attempt 2 of 2)...`);
        continue;
      }
      throw error;
    }
  }
}
