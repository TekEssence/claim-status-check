import test from "node:test";
import assert from "node:assert/strict";
import {
  exactMmDdYyyyPattern,
  formatMmDdYyyy,
  getDosSearchRange,
  getPrimaryDosColumnIndex,
  parseDateInput,
  parseWebsiteMmDdYyyy,
} from "../../../common/claims/dates";

test("parses Excel serial dates and formats with UTC getters to avoid off-by-one DOS", () => {
  const parsed = parseDateInput(46058);

  assert.ok(parsed);
  assert.equal(formatMmDdYyyy(parsed), "02/05/2026");
});

test("defaults ambiguous slash dates to the website mm/dd/yyyy format", () => {
  const parsed = parseDateInput("5/2/2026");

  assert.ok(parsed);
  assert.equal(formatMmDdYyyy(parsed), "05/02/2026");
});

test("rejects impossible slash dates instead of normalizing them", () => {
  assert.equal(parseDateInput("02/30/2026"), null);
  assert.equal(parseDateInput("04/31/2026"), null);
});

test("accepts valid leap-day slash dates", () => {
  const parsed = parseDateInput("02/29/2028");

  assert.ok(parsed);
  assert.equal(formatMmDdYyyy(parsed), "02/29/2028");
});

test("builds the +/- one day DOS search range without local timezone drift", () => {
  const parsed = parseDateInput("03/01/2026");

  assert.ok(parsed);
  assert.deepEqual(getDosSearchRange(parsed), {
    startDate: new Date(Date.UTC(2026, 1, 28)),
    endDate: new Date(Date.UTC(2026, 2, 2)),
    formattedDos: "03/01/2026",
    formattedStart: "02/28/2026",
    formattedEnd: "03/02/2026",
  });
});

test("parses website row dates as mm/dd/yyyy in UTC", () => {
  const parsed = parseWebsiteMmDdYyyy("Primary DOS 02/05/2026 Received 02/04/2026");

  assert.ok(parsed);
  assert.equal(parsed.getTime(), Date.UTC(2026, 1, 5));
});

test("identifies the Primary DOS column and creates an exact cell matcher", () => {
  const colIndex = getPrimaryDosColumnIndex(["Claim ID", "Received Date", "Primary DOS", "Status"]);

  assert.equal(colIndex, 3);
  assert.equal(exactMmDdYyyyPattern("02/05/2026").test(" 02/05/2026 "), true);
  assert.equal(exactMmDdYyyyPattern("02/05/2026").test("Received 02/05/2026"), false);
});
