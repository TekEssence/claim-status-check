import test from "node:test";
import assert from "node:assert/strict";
import { extractCheckNumbersFromClaimDetailText } from "../app/api/process-claims/covered-ra";

test("extracts unique check numbers from claim detail text", () => {
  const text = [
    "Claim Status: Processed",
    "Check Number: 001167",
    "Other Note",
    "Check No 001167",
    "Check # ABCD-7788",
  ].join(" ");

  assert.deepEqual(extractCheckNumbersFromClaimDetailText(text), ["001167", "ABCD-7788"]);
});
