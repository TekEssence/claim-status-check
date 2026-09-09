import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright-core";
import { ensureWaystarClaimAccount, WAYSTAR_CLAIM_ACCOUNT } from "../account";

function accountPage(initial: string, options: { missing?: boolean; noSuccess?: boolean; wrongHeader?: boolean } = {}) {
  let current = initial;
  const events: string[] = [];
  const page = {
    locator(selector: string) {
      const locator = {
        first: () => locator,
        filter: ({ hasText }: { hasText: RegExp }) => {
          assert.equal(hasText.test("MedRevenu LLC (12345)"), false);
          assert.equal(hasText.test(WAYSTAR_CLAIM_ACCOUNT), true);
          return locator;
        },
        waitFor: async () => {
          if (selector.includes("change-account-link") && options.missing) throw new Error("No matching account");
        },
        inputValue: async () => current,
        fill: async (value: string) => { events.push(`search:${value}`); },
        click: async () => {
          events.push(selector);
          if (selector.includes("change-account-link") && !options.wrongHeader) current = WAYSTAR_CLAIM_ACCOUNT;
        },
      };
      return locator;
    },
    waitForFunction: async (predicate: () => boolean) => {
      const confirmed = runInNewContext(`(${predicate.toString()})()`, {
        document: {
          querySelectorAll: () => [{ value: current, getClientRects: () => [1] }],
          body: { innerText: options.noSuccess ? "" : `Success\nYou have switched to the following account:\nAccount:\n${WAYSTAR_CLAIM_ACCOUNT}\nUser Name: Test` },
        },
      });
      if (!confirmed) throw new Error("Account confirmation timed out");
      events.push("confirmation");
    },
  } as unknown as Page;
  return { page, events };
}

test("keeps the required account when already selected", async () => {
  const { page, events } = accountPage(WAYSTAR_CLAIM_ACCOUNT);
  await ensureWaystarClaimAccount(page);
  assert.deepEqual(events, []);
});

test("switches another account and waits for success and account confirmation", async () => {
  const { page, events } = accountPage("BCO - Beach Cities Orthopedics (289939)");
  await ensureWaystarClaimAccount(page);
  assert.ok(events.includes("search:86750"));
  assert.equal(events.at(-1), "confirmation");
});

for (const failure of ["missing", "noSuccess", "wrongHeader"] as const) {
  test(`blocks claim search when account selection fails: ${failure}`, async () => {
    const { page } = accountPage("MedRevenu LLC (12345)", { [failure]: true });
    await assert.rejects(ensureWaystarClaimAccount(page), /Account selection could not be confirmed; claim search was stopped/);
  });
}
