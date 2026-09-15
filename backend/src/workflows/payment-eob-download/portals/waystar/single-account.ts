import type { Page } from "playwright-core";
import { normalizeWaystarClientName } from "./process-registry";

const SINGLE_ACCOUNT = ".header-account-no-child-account span:visible";

function organizationName(value: string): string {
  return value.replace(/^\s*Account Name\s*:\s*/i, "")
    .replace(/^\s*\d+(?:\s*\\\s*\d+)*\s*-\s*/, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim().replace(/\s+/g, " ").toLowerCase();
}

/** Return undefined for the existing searchable layout; never infer success from a timeout. */
export async function verifyPscdSingleAccount(page: Page, clientName: string, expectedAccount: string): Promise<string | undefined> {
  if (!normalizeWaystarClientName(clientName).startsWith("pscd")) return undefined;
  await page.locator(`.header-account-search-text:visible, ${SINGLE_ACCOUNT}`).first()
    .waitFor({ state: "visible", timeout: 60000 });
  if (await page.locator(".header-account-search-text:visible").count()) return undefined;

  const header = page.locator(SINGLE_ACCOUNT).first();
  const headerName = (await header.innerText()).trim();
  const profile = page.locator('#general .primary-label span').filter({ hasText: /^\s*Account Name\s*:/i });
  if (!await profile.count()) {
    await page.goto("https://mgmt.zirmed.com/ExternalUserManagement/AccountProfile/Index", { waitUntil: "domcontentloaded" });
  }
  await profile.first().waitFor({ state: "visible", timeout: 30000 });
  const profileName = (await profile.first().innerText()).trim();
  const activeHeader = (await header.innerText()).trim();
  const expected = organizationName(expectedAccount);
  const names = [headerName, activeHeader, profileName].map(organizationName);
  if (!expected || expected !== "physician surgery center of downey" || names.some((name) => name !== expected)) {
    throw new Error(`Waystar PSCD single-account verification failed. Expected "${expectedAccount}"; header showed "${activeHeader}"; profile showed "${profileName}". Payment EOB processing was stopped.`);
  }
  return profileName.replace(/^\s*Account Name\s*:\s*/i, "");
}
