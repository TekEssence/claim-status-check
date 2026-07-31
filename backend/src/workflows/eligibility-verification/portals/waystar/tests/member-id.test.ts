import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWaystarMemberIdForPayer } from "../portal";

test("enters Aetna Medicare PPO member IDs exactly as provided", () => {
  assert.equal(
    normalizeWaystarMemberIdForPayer(
      "Aetna (Medicare Advantage) (60054MA)",
      "123456789",
    ),
    "123456789",
  );
});

test("keeps BayCare numeric member-ID prefixing", () => {
  assert.equal(
    normalizeWaystarMemberIdForPayer(
      "BayCare Plus Medicare Advantage (81079)",
      "123456789",
    ),
    "000123456789",
  );
});