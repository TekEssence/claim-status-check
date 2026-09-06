import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { isWaystarAdditionalAuthenticationPending } from "../portal";
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
