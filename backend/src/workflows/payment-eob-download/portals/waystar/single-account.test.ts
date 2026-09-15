import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { verifyPscdSingleAccount } from "./single-account";

const organization = "Physician Surgery Center of Downey";
const account = `55030 \\ 50508 - ${organization}`;

function accountPage(options: { searchable?: boolean; header?: string; profile?: string; away?: boolean; missing?: boolean } = {}) {
  const events: string[] = [];
  let away = options.away;
  const page = {
    locator(selector: string) {
      const profile = selector.startsWith("#general");
      const locator = {
        first: () => locator,
        filter: () => locator,
        count: async () => profile ? Number(!away && !options.missing) : Number(options.searchable),
        waitFor: async () => { if (profile && options.missing) throw new Error("Profile unavailable"); },
        innerText: async () => profile ? options.profile ?? `Account Name: ${account}` : options.header ?? `${account} (178536)`,
      };
      return locator;
    },
    goto: async (url: string) => { events.push(url); away = false; },
  } as unknown as Page;
  return { page, events };
}

test("verifies the supplied PSCD single-account layout against mapped names", async () => {
  for (const mapped of [organization, account, `${account} (178536)`, `  PHYSICIAN   SURGERY CENTER OF DOWNEY `]) {
    const { page, events } = accountPage();
    assert.equal(await verifyPscdSingleAccount(page, "PSCD", mapped), account);
    assert.deepEqual(events, []);
  }
});

test("leaves searchable PSCD accounts on the existing selection path", async () => {
  const { page, events } = accountPage({ searchable: true });
  assert.equal(await verifyPscdSingleAccount(page, "PSCD", organization), undefined);
  assert.deepEqual(events, []);
});

test("does not inspect other clients", async () => {
  assert.equal(await verifyPscdSingleAccount({} as Page, "BPH", organization), undefined);
});

test("opens Account Profile when the single-account landing page is elsewhere", async () => {
  const { page, events } = accountPage({ away: true });
  assert.equal(await verifyPscdSingleAccount(page, "PSCD", organization), account);
  assert.deepEqual(events, ["https://mgmt.zirmed.com/ExternalUserManagement/AccountProfile/Index"]);
});

test("rejects wrong, conflicting, blank, and partial account identities", async () => {
  for (const options of [{ header: "Another Surgery Center" }, { profile: "Account Name: Another Surgery Center" }, { profile: "" }]) {
    await assert.rejects(verifyPscdSingleAccount(accountPage(options).page, "PSCD", organization), /verification failed/);
  }
  for (const mapped of ["", "Physician", "Another Surgery Center"]) {
    await assert.rejects(verifyPscdSingleAccount(accountPage().page, "PSCD", mapped), /verification failed/);
  }
});

test("stops when the General account name cannot be read", async () => {
  await assert.rejects(verifyPscdSingleAccount(accountPage({ missing: true }).page, "PSCD", organization), /Profile unavailable/);
});
