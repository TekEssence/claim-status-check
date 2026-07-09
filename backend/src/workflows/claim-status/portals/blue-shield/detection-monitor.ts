import type { Page, Response } from "playwright-core";

export class BlueShieldSecurityDetectionError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "BlueShieldSecurityDetectionError";
  }
}

const SECURITY_PATTERNS = [
  { reason: "captcha", pattern: /captcha|recaptcha/i },
  { reason: "account_locked", pattern: /account\s+locked|locked\s+account/i },
  { reason: "access_denied", pattern: /access\s+denied|not\s+authorized|unauthorized/i },
  { reason: "security_verification", pattern: /security\s+verification|verify\s+your\s+identity/i },
  { reason: "unexpected_logout", pattern: /session\s+expired|sign\s+in\s+again|logged\s+out/i },
];

const responseDetections = new WeakMap<Page, BlueShieldSecurityDetectionError>();

export function assertAllowedResponse(response: Response): void {
  const status = response.status();
  if (status === 403 || status === 429) {
    throw new BlueShieldSecurityDetectionError(`http_${status}`, `Blue Shield security response detected: HTTP ${status}.`);
  }
}

export async function assertNoSecurityBlock(page: Page): Promise<void> {
  const responseDetection = responseDetections.get(page);
  if (responseDetection) {
    throw responseDetection;
  }

  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  for (const detector of SECURITY_PATTERNS) {
    if (detector.pattern.test(text)) {
      throw new BlueShieldSecurityDetectionError(
        detector.reason,
        `Blue Shield security condition detected: ${detector.reason.replace(/_/g, " ")}.`,
      );
    }
  }
}

export function attachBlueShieldDetectionMonitor(page: Page): void {
  page.on("response", (response) => {
    try {
      assertAllowedResponse(response);
    } catch (error) {
      if (error instanceof BlueShieldSecurityDetectionError) {
        responseDetections.set(page, error);
      } else {
        throw error;
      }
    }
  });
}
