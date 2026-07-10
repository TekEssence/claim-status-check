import type { BrowserContext, Page } from "playwright-core";

const surveyPattern = /Powered by Verint|how satisfied are you with the website|primary reason for filling out this survey/i;
const feedbackPagePattern = /(?:^|\.)opinionlab\.com$|verint/i;

export function isBlueShieldSurveyText(text: string): boolean {
  return surveyPattern.test(text);
}

export function isBlueShieldFeedbackPage(url: string, title = ""): boolean {
  try {
    return feedbackPagePattern.test(new URL(url).hostname) || /Verint.*Feedback|Provide Your Feedback/i.test(title);
  } catch {
    return /opinionlab|verint/i.test(url) || /Verint.*Feedback|Provide Your Feedback/i.test(title);
  }
}

async function closeFeedbackPage(page: Page, log: (message: string) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 20 && !page.isClosed(); attempt++) {
    const title = await page.title().catch(() => "");
    if (isBlueShieldFeedbackPage(page.url(), title)) {
      await page.close().catch(() => {});
      await log("Blue Shield Verint feedback popup was closed.");
      return;
    }
    await page.waitForTimeout(250).catch(() => {});
  }
}

export function monitorBlueShieldFeedbackPopups(
  context: BrowserContext,
  log: (message: string) => Promise<void>,
): void {
  context.on("page", (page) => {
    void closeFeedbackPage(page, log);
  });
  for (const page of context.pages()) {
    void closeFeedbackPage(page, log);
  }
}

export async function dismissBlueShieldSurvey(page: Page): Promise<boolean> {
  let dismissed = false;

  await page.evaluate(() => {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='button'], iframe"))) {
      const label = `${element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${element.getAttribute("href") ?? ""} ${element.getAttribute("src") ?? ""}`;
      if (!/opinionlab|verint|^\s*feedback\s*$/i.test(label.trim())) continue;
      element.style.setProperty("display", "none", "important");
      element.style.setProperty("pointer-events", "none", "important");
    }
  }).catch(() => {});

  for (const frame of page.frames()) {
    const bodyText = await frame.locator("body").innerText({ timeout: 700 }).catch(() => "");
    if (!isBlueShieldSurveyText(bodyText)) continue;

    const closeControl = frame.locator([
      "button[aria-label*='close' i]",
      "[role='button'][aria-label*='close' i]",
      "button:has-text('No thanks')",
      "button:has-text('Close')",
      "a:has-text('Close')",
    ].join(", ")).first();

    if (await closeControl.isVisible({ timeout: 500 }).catch(() => false)) {
      await closeControl.click({ timeout: 3000 }).catch(() => {});
      dismissed = true;
    }

    if (frame !== page.mainFrame()) {
      const frameElement = await frame.frameElement().catch(() => null);
      if (frameElement) {
        await frameElement.evaluate((element) => {
          const frame = element as Element;
          const container = frame.closest("[role='dialog']") ?? frame;
          (container as HTMLElement).style.setProperty("display", "none", "important");
          (container as HTMLElement).style.setProperty("pointer-events", "none", "important");
        }).catch(() => {});
        dismissed = true;
      }
    }
  }

  await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, "i");
    for (const element of Array.from(document.querySelectorAll("body *"))) {
      if (!pattern.test(element.textContent ?? "")) continue;
      let container: HTMLElement | null = element as HTMLElement;
      while (container.parentElement && container.parentElement !== document.body) {
        const style = window.getComputedStyle(container);
        if (container.getAttribute("role") === "dialog" || style.position === "fixed") break;
        container = container.parentElement;
      }
      if (container && container !== document.body) {
        container.style.setProperty("display", "none", "important");
        container.style.setProperty("pointer-events", "none", "important");
      }
      break;
    }
  }, surveyPattern.source).catch(() => {});

  return dismissed;
}
