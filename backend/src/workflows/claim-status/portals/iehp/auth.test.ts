import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { completeIehpLoginAfterCredentials, IEHP_OTP_INPUT_NAME, IEHP_OTP_TIMEOUT_MS } from "./auth";
import { IEHP_SELECTORS } from "./selectors";

type PageState = "signed-in" | "otp" | "rejected";

function mockLoginPage(initial: PageState, afterSubmit: PageState = "signed-in") {
  let state = initial;
  let filledCode = "";
  const page = {
    locator(selector: string) {
      return {
        first() {
          return {
            async isVisible() {
              if (selector === IEHP_SELECTORS.auth.signedInIndicators[0]) return state === "signed-in";
              if (selector === IEHP_SELECTORS.auth.otpInput) return state !== "signed-in";
              if (selector === IEHP_SELECTORS.auth.otpRejected) return state === "rejected";
              if (selector === IEHP_SELECTORS.auth.otpSubmit) return state === "otp";
              return false;
            },
            async fill(value: string) { filledCode = value; },
            async click() { state = afterSubmit; },
            async press() { state = afterSubmit; },
          };
        },
      };
    },
    async waitForTimeout() {},
  } as unknown as Page;
  return { page, getCode: () => filledCode };
}

test("IEHP login without an OTP continues without requesting input", async () => {
  const { page } = mockLoginPage("signed-in");
  const events: Record<string, unknown>[] = [];
  await completeIehpLoginAfterCredentials(page, async () => { throw new Error("Unexpected OTP wait"); }, async event => { events.push(event); });
  assert.deepEqual(events, []);
});

test("IEHP OTP request waits, then resumes on the same page with the supplied code", async () => {
  const { page, getCode } = mockLoginPage("otp");
  const events: Record<string, unknown>[] = [];
  let reply!: (value: string) => void;
  let requested!: () => void;
  const requestPublished = new Promise<void>(resolve => { requested = resolve; });
  const waiting = completeIehpLoginAfterCredentials(
    page,
    (inputName, timeoutMs) => {
      assert.equal(inputName, IEHP_OTP_INPUT_NAME);
      assert.equal(timeoutMs, IEHP_OTP_TIMEOUT_MS);
      return new Promise<string>(resolve => { reply = resolve; });
    },
    async event => { events.push(event); requested(); },
  );
  await requestPublished;
  assert.deepEqual(events, [{
    type: "input_request", inputName: "iehp_otp", label: "IEHP verification code",
    message: "Enter the IEHP verification code within 6 minutes.", timeoutMs: 360000,
  }]);
  assert.equal(getCode(), "");
  reply("493017");
  await waiting;
  assert.equal(getCode(), "493017");
});

test("IEHP enters the submitted OTP into the existing browser page", async () => {
  const { page, getCode } = mockLoginPage("otp");
  let requestedName = "";
  await completeIehpLoginAfterCredentials(
    page,
    async inputName => { requestedName = inputName; return "712804"; },
    async () => {},
  );
  assert.equal(requestedName, "iehp_otp");
  assert.equal(getCode(), "712804");
});

test("IEHP rejects an invalid or expired OTP without echoing its value", async () => {
  const { page } = mockLoginPage("otp", "rejected");
  const events: Record<string, unknown>[] = [];
  const code = "secret-493017";
  await assert.rejects(
    completeIehpLoginAfterCredentials(page, async () => code, async event => { events.push(event); }),
    /IEHP OTP was invalid or expired/,
  );
  assert.equal(JSON.stringify(events).includes(code), false);
});

test("IEHP OTP timeout has a clear error and does not expose the code in events", async () => {
  const { page } = mockLoginPage("otp");
  const events: Record<string, unknown>[] = [];
  await assert.rejects(
    completeIehpLoginAfterCredentials(
      page,
      async () => { throw new Error("OTP was not sent within 6 minutes."); },
      async event => { events.push(event); },
    ),
    /IEHP OTP timed out after 6 minutes/,
  );
  assert.equal(events[0].type, "input_request");
  assert.equal(Object.hasOwn(events[0], "value"), false);
  assert.equal(Object.hasOwn(events[0], "otp"), false);
});

test("IEHP OTP is absent from request events and reported errors", async () => {
  const { page } = mockLoginPage("otp", "rejected");
  const code = "private-otp-712804";
  const events: Record<string, unknown>[] = [];
  let message = "";
  try {
    await completeIehpLoginAfterCredentials(page, async () => code, async event => { events.push(event); });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /invalid or expired/);
  assert.equal(JSON.stringify({ events, message }).includes(code), false);
});
