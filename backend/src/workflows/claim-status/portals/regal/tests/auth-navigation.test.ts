import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import { expectsDirectRegalRedirect, waitForRegalAfterMfa } from "../login-job";
import { regalConfig } from "../config";

function authPage(options: { dashboard?: boolean; rea?: boolean; url?: string } = {}): Page {
  return {
    url: () => options.url || "https://regalmed.okta.com/",
    isClosed: () => false,
    frames: () => [{
      locator: (selector: string) => ({
        count: async () => Number(Boolean(options.rea && selector === regalConfig.selectors.siteSelect)),
      }),
    }],
    locator: (selector: string) => ({
      first: () => ({
        isVisible: async () => Boolean(options.dashboard && selector === regalConfig.selectors.dashboardHeading),
        innerText: async () => "",
      }),
    }),
  } as unknown as Page;
}

test("Regal recognizes an OAuth redirect directly to REA", () => {
  const url = "https://regalmed.okta.com/oauth2/default/v1/authorize?redirect_uri=https%3A%2F%2Frea.regalmed.com%2Fproduction%2FOktaLogin.asp";
  assert.equal(expectsDirectRegalRedirect(authPage({ url })), true);
  assert.equal(expectsDirectRegalRedirect(authPage()), false);
});

test("Regal waits for the new REA tab after MFA instead of reopening an older Okta dashboard", async () => {
  const mfaPage = authPage();
  const oldDashboard = authPage({ dashboard: true });
  const reaPage = authPage({ rea: true, url: "https://rea.regalmed.com/production/home.aspx" });
  let polls = 0;
  const browserContext = {
    pages: () => ++polls === 1 ? [oldDashboard, mfaPage] : [oldDashboard, mfaPage, reaPage],
  } as unknown as BrowserContext;

  const destination = await waitForRegalAfterMfa(mfaPage, browserContext, 0, oldDashboard);
  assert.equal(destination.state, "rea");
  assert.equal(destination.page, reaPage);
});

test("Regal keeps waiting when a frame detaches during the post-OTP redirect", async () => {
  let frameChecks = 0;
  const reaPage = {
    ...authPage({ url: "https://rea.regalmed.com/production/home.aspx" }),
    frames: () => [{
      locator: (selector: string) => ({
        count: async () => {
          if (++frameChecks === 1) throw new Error("locator.count: Frame was detached");
          return Number(selector === regalConfig.selectors.siteSelect);
        },
      }),
    }],
  } as Page;
  const browserContext = { pages: () => [reaPage] } as unknown as BrowserContext;

  const destination = await waitForRegalAfterMfa(reaPage, browserContext, 0);
  assert.equal(destination.state, "rea");
  assert.equal(destination.page, reaPage);
  assert.ok(frameChecks > 1);
});
