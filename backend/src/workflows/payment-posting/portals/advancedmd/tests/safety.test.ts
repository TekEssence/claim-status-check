import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const IMPLEMENTATION_FILES = [
  path.resolve("backend/src/workflows/payment-posting/portals/advancedmd/portal.ts"),
  path.resolve("backend/src/workflows/payment-posting/portals/advancedmd/scraper.ts"),
];

const DANGEROUS_PATTERNS = [
  /getByRole\s*\([^)]*name\s*:\s*[^)]*post[^)]*\)\s*\.click/iu,
  /getByText\s*\([^)]*post[^)]*\)\s*\.click/iu,
  /locator\s*\([^)]*post[^)]*\)\s*\.click/iu,
  /click\s*\([^)]*(save\s+and\s+post|submit\s+payment|finalize\s+payment|post)[^)]*\)/iu,
];

test("AdvancedMD implementation has no prohibited post action locators or clicks", () => {
  for (const filePath of IMPLEMENTATION_FILES) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const pattern of DANGEROUS_PATTERNS) {
      assert.equal(pattern.test(source), false, `${filePath} contains dangerous pattern ${pattern}`);
    }
  }
});

