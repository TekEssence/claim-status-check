import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVANCEDMD_PAYMENT_POSTING_SELECTORS,
  AdvancedMdMissingSelectorError,
  assertAdvancedMdSelectorsReady,
  getMissingAdvancedMdSelectors,
  type AdvancedMdSelectorConfig,
} from "../portal";

test("default AdvancedMD selector config is enabled for dry-run automation", () => {
  assert.deepEqual(getMissingAdvancedMdSelectors(ADVANCEDMD_PAYMENT_POSTING_SELECTORS), []);
  assert.doesNotThrow(() => assertAdvancedMdSelectorsReady(ADVANCEDMD_PAYMENT_POSTING_SELECTORS));
});

test("selector validation still rejects a deliberately incomplete config", () => {
  const incomplete: AdvancedMdSelectorConfig = {
    ...ADVANCEDMD_PAYMENT_POSTING_SELECTORS,
    login: {
      ...ADVANCEDMD_PAYMENT_POSTING_SELECTORS.login,
      usernameInput: "",
    },
  };

  assert.throws(
    () => assertAdvancedMdSelectorsReady(incomplete),
    AdvancedMdMissingSelectorError,
  );
});
