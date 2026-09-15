import type { BrowserContext } from 'playwright-core';

export function watchMediCalCancellation(context: BrowserContext, isCancelled?: () => boolean) {
  let closing = false;
  const timer = setInterval(() => {
    if (!closing && isCancelled?.()) {
      closing = true;
      void context.close().catch(() => {});
    }
  }, 250);
  return () => clearInterval(timer);
}
