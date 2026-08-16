import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright-core";

const BROWSER_EVAL_HELPERS = `
(() => {
  const root = globalThis;
  if (typeof root.__name !== "function") {
    Object.defineProperty(root, "__name", {
      value: (target) => target,
      configurable: true,
    });
  }
})();
`;

const patchedBrowsers = new WeakSet<Browser>();
const patchedContexts = new WeakSet<BrowserContext>();
const patchedPages = new WeakSet<Page>();
let launchersPatched = false;

export async function installBrowserEvalHelpers(page: Page): Promise<void> {
  if (!patchedPages.has(page)) {
    patchedPages.add(page);
    await page.addInitScript({ content: BROWSER_EVAL_HELPERS }).catch(() => {});
  }
  await page.evaluate(BROWSER_EVAL_HELPERS).catch(() => {});
}

export async function installBrowserContextEvalHelpers(context: BrowserContext): Promise<void> {
  if (!patchedContexts.has(context)) {
    patchedContexts.add(context);
    await context.addInitScript({ content: BROWSER_EVAL_HELPERS }).catch(() => {});
    patchContext(context);
  }

  for (const page of context.pages()) {
    await installBrowserEvalHelpers(page);
  }
}

export function patchPlaywrightBrowserEvalHelpers(): void {
  if (launchersPatched) return;
  launchersPatched = true;

  for (const browserType of [chromium, firefox, webkit]) {
    const originalLaunch = browserType.launch.bind(browserType);
    browserType.launch = (async (...args: Parameters<typeof browserType.launch>) => {
      const browser = await originalLaunch(...args);
      patchBrowser(browser);
      return browser;
    }) as typeof browserType.launch;

    const originalLaunchPersistentContext = browserType.launchPersistentContext.bind(browserType);
    browserType.launchPersistentContext = (async (
      ...args: Parameters<typeof browserType.launchPersistentContext>
    ) => {
      const context = await originalLaunchPersistentContext(...args);
      await installBrowserContextEvalHelpers(context);
      return context;
    }) as typeof browserType.launchPersistentContext;
  }
}

function patchBrowser(browser: Browser): void {
  if (patchedBrowsers.has(browser)) return;
  patchedBrowsers.add(browser);

  const originalNewContext = browser.newContext.bind(browser);
  browser.newContext = (async (...args: Parameters<Browser["newContext"]>) => {
    const context = await originalNewContext(...args);
    await installBrowserContextEvalHelpers(context);
    return context;
  }) as Browser["newContext"];

  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = (async (...args: Parameters<Browser["newPage"]>) => {
    const page = await originalNewPage(...args);
    await installBrowserEvalHelpers(page);
    return page;
  }) as Browser["newPage"];
}

function patchContext(context: BrowserContext): void {
  const originalNewPage = context.newPage.bind(context);
  context.newPage = (async (...args: Parameters<BrowserContext["newPage"]>) => {
    const page = await originalNewPage(...args);
    await installBrowserEvalHelpers(page);
    return page;
  }) as BrowserContext["newPage"];
}
