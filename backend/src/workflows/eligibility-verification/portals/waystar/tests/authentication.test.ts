import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { handleOptionalProfileUpdate, isWaystarAdditionalAuthenticationPending } from "../portal";
import { WAYSTAR_SELECTORS } from "../selectors";

function pageWithVisibleSelectors(...visible: string[]): Page {
  return {
    locator: (selector: string) => ({
      first: () => ({ isVisible: async () => visible.includes(selector) }),
    }),
  } as unknown as Page;
}

test("dashboard search boxes do not cause a false authentication failure", async () => {
  assert.equal(await isWaystarAdditionalAuthenticationPending(pageWithVisibleSelectors(
    WAYSTAR_SELECTORS.navigation.eligibility,
    WAYSTAR_SELECTORS.additionalAuth.answer,
  )), false);
});

test("authenticated account header takes precedence over dashboard text inputs", async () => {
  assert.equal(await isWaystarAdditionalAuthenticationPending(pageWithVisibleSelectors(
    ".header-account-search-text",
    WAYSTAR_SELECTORS.additionalAuth.answer,
  )), false);
});

test("an unanswered challenge remains pending", async () => {
  assert.equal(await isWaystarAdditionalAuthenticationPending(pageWithVisibleSelectors(
    WAYSTAR_SELECTORS.additionalAuth.answer,
  )), true);
});

test("optional Waystar profile update is skipped before dashboard navigation", async () => {
  const clickedLabels: string[] = [];
  const page = {
    frames: () => [{
      url: () => "https://mgmt.zirmed.com/ExternalUserManagement/ProfileUpdate/Index",
      evaluate: async (_callback: unknown, label: string) => {
        clickedLabels.push(label);
        return label === "Get Started" || label === "Skip This Step";
      },
    }],
    waitForLoadState: async () => {},
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
  } as unknown as Page;

  await handleOptionalProfileUpdate(page);

  assert.deepEqual(clickedLabels, ["Get Started", "Skip This Step"]);
});
