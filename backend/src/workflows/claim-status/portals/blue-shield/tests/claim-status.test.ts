import assert from "node:assert/strict";
import test from "node:test";
import { blueShieldClaimStatusTestHooks } from "../claim-status";

const { expandDosRange } = blueShieldClaimStatusTestHooks;

test("expands Blue Shield exact DOS search by one day on each side", () => {
  assert.deepEqual(
    expandDosRange({ start: "09/08/2024", end: "09/08/2024", display: "09/08/2024" }, 1),
    {
      start: "09/07/2024",
      end: "09/09/2024",
      display: "09/08/2024 expanded +/- 1 day(s)",
    },
  );
});
