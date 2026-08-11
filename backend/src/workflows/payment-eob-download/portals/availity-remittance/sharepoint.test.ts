import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentEobCredentials } from "../../types";
import { resolvePaymentEobSharePointConfig } from "./sharepoint";

const ENV_KEYS = [
  "PAYMENT_EOB_SHAREPOINT_TENANT_ID",
  "PAYMENT_EOB_SHAREPOINT_CLIENT_ID",
  "PAYMENT_EOB_SHAREPOINT_CLIENT_SECRET",
  "PAYMENT_EOB_SHAREPOINT_SITE_URL",
  "PAYMENT_EOB_SHAREPOINT_FOLDER",
];

function baseCredentials(sharePoint?: PaymentEobCredentials["sharePoint"]): PaymentEobCredentials {
  return {
    loginUrl: "https://essentials.availity.com/login",
    username: "user",
    password: "password",
    totpSecret: "JBSWY3DPEHPK3PXP",
    lookbackDays: 10,
    sharePoint,
  };
}

function withCleanSharePointEnv(fn: () => void): void {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("returns null when Payment EOB SharePoint upload is not configured", () => {
  withCleanSharePointEnv(() => {
    assert.equal(resolvePaymentEobSharePointConfig(baseCredentials()), null);
  });
});

test("resolves Payment EOB SharePoint settings from environment", () => {
  withCleanSharePointEnv(() => {
    process.env.PAYMENT_EOB_SHAREPOINT_TENANT_ID = "tenant-env";
    process.env.PAYMENT_EOB_SHAREPOINT_CLIENT_ID = "client-env";
    process.env.PAYMENT_EOB_SHAREPOINT_CLIENT_SECRET = "secret-env";
    process.env.PAYMENT_EOB_SHAREPOINT_SITE_URL = "https://contoso.sharepoint.com/sites/CH001_PEDI_BENT";
    process.env.PAYMENT_EOB_SHAREPOINT_FOLDER = "Documents/Payments Tracker/PaymentEobDownloads";

    assert.deepEqual(resolvePaymentEobSharePointConfig(baseCredentials()), {
      tenantId: "tenant-env",
      clientId: "client-env",
      clientSecret: "secret-env",
      siteUrl: "https://contoso.sharepoint.com/sites/CH001_PEDI_BENT",
      folderPath: "Documents/Payments Tracker/PaymentEobDownloads",
    });
  });
});

test("Payment EOB SharePoint settings from credential Excel override environment values", () => {
  withCleanSharePointEnv(() => {
    process.env.PAYMENT_EOB_SHAREPOINT_TENANT_ID = "tenant-env";
    process.env.PAYMENT_EOB_SHAREPOINT_CLIENT_ID = "client-env";
    process.env.PAYMENT_EOB_SHAREPOINT_CLIENT_SECRET = "secret-env";
    process.env.PAYMENT_EOB_SHAREPOINT_SITE_URL = "https://env.sharepoint.com/sites/site";
    process.env.PAYMENT_EOB_SHAREPOINT_FOLDER = "Documents/Env";

    assert.deepEqual(resolvePaymentEobSharePointConfig(baseCredentials({
      tenantId: "tenant-excel",
      clientId: "client-excel",
      clientSecret: "secret-excel",
      siteUrl: "https://excel.sharepoint.com/sites/site",
      folderPath: "Documents/Payments Tracker/PaymentEobDownloads",
    })), {
      tenantId: "tenant-excel",
      clientId: "client-excel",
      clientSecret: "secret-excel",
      siteUrl: "https://excel.sharepoint.com/sites/site",
      folderPath: "Documents/Payments Tracker/PaymentEobDownloads",
    });
  });
});

test("throws a clear error for partial Payment EOB SharePoint configuration", () => {
  withCleanSharePointEnv(() => {
    assert.throws(
      () => resolvePaymentEobSharePointConfig(baseCredentials({ tenantId: "tenant-only" })),
      /SharePoint upload is configured but missing/,
    );
  });
});
