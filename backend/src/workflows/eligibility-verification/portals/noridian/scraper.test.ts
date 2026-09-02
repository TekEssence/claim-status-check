import assert from "node:assert/strict";
import test from "node:test";
import { parseNoridianPatientName } from "./scraper";

test("parses Noridian LAST NAME, FIRST NAME input", () => {
  assert.deepEqual(parseNoridianPatientName("  SMITH, JOHN  "), {
    lastName: "SMITH",
    firstName: "JOHN",
  });
});

test("uses the first given-name portion when a middle name is present", () => {
  assert.deepEqual(parseNoridianPatientName("SMITH, JOHN PAUL"), {
    lastName: "SMITH",
    firstName: "JOHN",
  });
});

test("rejects names that do not use the required comma format", () => {
  assert.throws(() => parseNoridianPatientName("JOHN SMITH"), /LAST NAME, FIRST NAME/);
});
