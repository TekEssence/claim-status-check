import test from "node:test";
import assert from "node:assert/strict";
const { dismissPasswordExpiryReminderIfPresent, SELECTORS } = require("./mfa.page.js");

function mockPage({ reminder = false, code = false, method = false, reminderAfterChecks = 0 }:
  { reminder?: boolean; code?: boolean; method?: boolean; reminderAfterChecks?: number } = {}) {
  let clicks = 0;
  let reminderChecks = 0;
  const deferButton = {
    isVisible: async () => reminder && ++reminderChecks > reminderAfterChecks,
    click: async () => { clicks += 1; reminder = false; code = true; },
    waitFor: async ({ state }: { state: string }) => {
      assert.equal(state, "hidden");
      assert.equal(reminder, false);
    },
  };
  return {
    get clicks() { return clicks; },
    get codeVisible() { return code; },
    getByRole: (role: string, options: { name: RegExp }) => {
      assert.equal(role, "button");
      assert.match("I'll change my password next time", options.name);
      assert.equal(options.name.test("Change my password"), false);
      return { first: () => deferButton };
    },
    locator: (selector: string) => ({ first: () => ({
      isVisible: async () => selector === SELECTORS.codeInput ? code : method,
    }) }),
  };
}

test("dismisses the optional Availity password reminder before MFA", async () => {
  const page = mockPage({ reminder: true });
  assert.equal(await dismissPasswordExpiryReminderIfPresent(page), true);
  assert.equal(page.clicks, 1);
  assert.equal(page.codeVisible, true);
});

test("waits for a password reminder that appears after login navigation", async () => {
  const page = mockPage({ reminder: true, reminderAfterChecks: 2 });
  assert.equal(await dismissPasswordExpiryReminderIfPresent(page, 1000), true);
  assert.equal(page.clicks, 1);
});

test("continues directly when the MFA code page appears without a reminder", async () => {
  const page = mockPage({ code: true });
  assert.equal(await dismissPasswordExpiryReminderIfPresent(page), false);
  assert.equal(page.clicks, 0);
});

test("continues directly when the MFA method page appears without a reminder", async () => {
  const page = mockPage({ method: true });
  assert.equal(await dismissPasswordExpiryReminderIfPresent(page), false);
  assert.equal(page.clicks, 0);
});
