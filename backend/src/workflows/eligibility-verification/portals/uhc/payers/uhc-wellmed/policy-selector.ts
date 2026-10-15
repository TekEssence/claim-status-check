import type { Frame, Locator, Page } from "playwright-core";

/**
 * Result of selectPolicy operation.
 */
export type SelectPolicyResult = {
  /** Whether a policy was successfully selected */
  selected: boolean;
  /** The page or frame where the selection happened (use for subsequent operations) */
  ctx: Page | Frame;
  /** Which matching pass succeeded: "primary" | "medicaid" */
  matchedBy?: "primary" | "medicaid";
};

/**
 * If true, require Member ID to match (with flexible matching).
 * When false, idMatches always returns true.
 */
const REQUIRE_MEMBER_ID_MATCH = true;

/**
 * If true, require Payer Status == "primary".
 * When false, payer check is skipped.
 */
const REQUIRE_PAYER_PRIMARY = true;

/**
 * If true, require Coverage Type == "medical".
 * When false, coverage check is skipped.
 */
const REQUIRE_COVERAGE_MEDICAL = true;

/**
 * Plan Type patterns that count as a "primary" match.
 * Case-insensitive (all regexes use the 'i' flag).
 * Medicaid is NOT included - never select Medicaid plans.
 */
const PLAN_TYPE_OK: RegExp[] = [
  /point[\s-]*of[\s-]*service|\bpos\b/i,
  /(health maintenance organization|\bhmo\b).*medicare risk/i,
  /exclusive provider organization|\bepo\b/i,
  /medicare primary/i,
];

/**
 * True when the plan type is one of the allowed "primary" patterns.
 */
export function isAllowedPlanType(plan: string): boolean {
  return PLAN_TYPE_OK.some((re) => re.test(plan));
}

/**
 * True when the plan type indicates Medicaid.
 * Kept for reference but NOT used for selection (Medicaid never selected).
 */
export function isMedicaidPlanType(plan: string): boolean {
  return /medicaid/i.test(plan);
}

/**
 * Normalizes a Member ID for comparison: trim, collapse whitespace, lowercase, strip non-alphanumeric.
 */
function normalizeMemberId(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Normalizes a generic field value for comparison: trim, collapse whitespace, lowercase.
 */
function normalizeField(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Masks a Member ID for logging: "len=<n> ends=***<last 3 chars>"
 */
function maskId(id: string): string {
  const len = id.length;
  const last3 = len >= 3 ? id.slice(-3) : id.padStart(3, "*");
  return `len=${len} ends=***${last3}`;
}

/**
 * Flexible Member ID matching:
 * - Equal after normalization, OR
 * - Equal after stripping leading zeros, OR
 * - Both lengths >= 6 and one contains the other (after normalization).
 * When REQUIRE_MEMBER_ID_MATCH is false, always returns true.
 */
function idMatches(cardId: string, wantedId: string): boolean {
  if (!REQUIRE_MEMBER_ID_MATCH) return true;
  const normCard = normalizeMemberId(cardId);
  const normWanted = normalizeMemberId(wantedId);
  if (normCard === normWanted) return true;
  const stripLeadingZeros = (s: string) => s.replace(/^0+/, "") || "0";
  if (stripLeadingZeros(normCard) === stripLeadingZeros(normWanted)) return true;
  if (normCard.length >= 6 && normWanted.length >= 6) {
    if (normCard.includes(normWanted) || normWanted.includes(normCard)) return true;
  }
  return false;
}

/**
 * Polls the page and all frames until a Select button (exact) appears.
 * Returns the Page or Frame that contains the results.
 * Logs the URL (without hash) and Select button count.
 */
async function findResultsContext(page: Page, timeoutMs = 35_000): Promise<Page | Frame> {
  const deadline = Date.now() + timeoutMs;
  const urlNoHash = page.url().split("#")[0];
  console.log(`[findResultsContext] Polling for results page. URL: ${urlNoHash}`);

  while (Date.now() < deadline) {
    const contexts: (Page | Frame)[] = [page];
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) contexts.push(frame);
    }

    for (const ctx of contexts) {
      const count = await ctx.getByRole("button", { name: "Select", exact: true }).count().catch(() => 0);
      if (count > 0) {
        console.log(`[findResultsContext] Found ${count} Select button(s) in ${ctx === page ? "main page" : "frame"}`);
        return ctx;
      }
    }

    await page.waitForTimeout(500);
  }

  // Timeout: build a diagnostic message showing the URL and whether a details page is present
  let planTypePresent = false;
  for (const ctx of [page, ...page.frames().filter((frame) => frame !== page.mainFrame())]) {
    const planTypeCount = await ctx.getByTestId("plan-type").count().catch(() => 0);
    if (planTypeCount > 0) {
      planTypePresent = true;
      break;
    }
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Select buttons on Member Search Results page. ` +
      `URL: ${urlNoHash} | getByTestId("plan-type") present: ${planTypePresent}`,
  );
}

/**
 * Raw fields read from a single policy card.
 */
export type RawCard = {
  title: string;
  payer: string;
  coverage: string;
  plan: string;
  id: string;
};

/**
 * From one Select button, walks up parentElement until it finds the card
 * (the element whose innerText contains "Member ID"), then reads the span
 * after each label ("Payer Status", "Coverage Type", "Plan Type", "Member ID")
 * plus the h1 text as the title. Returns raw (trimmed) values.
 */
async function readRawCard(btn: Locator): Promise<RawCard | null> {
  return btn.evaluate((el) => {
    function findCard(node: Element | null): Element | null {
      let current: Element | null = node;
      for (let depth = 0; depth < 15 && current; depth += 1) {
        const text = current instanceof HTMLElement ? current.innerText : current.textContent;
        if (text && /Member ID/i.test(text)) return current;
        current = current.parentElement;
      }
      return null;
    }

    const card = findCard(el);
    if (!card) {
      console.log("[readRawCard] Card container not found (no ancestor contains 'Member ID')");
      return null;
    }

    const spans = card.querySelectorAll("span");
    const fields: Record<string, string> = {};

    // Normalize label for matching: trim, remove trailing colon, collapse whitespace
    const normLabel = (s: string) => s.trim().replace(/:+$/, "").replace(/\s+/g, " ");

    for (let i = 0; i < spans.length; i += 1) {
      const label = normLabel(spans[i].textContent ?? "");
      const normalized = label.toLowerCase();
      if (
        normalized === "payer status" ||
        normalized === "coverage type" ||
        normalized === "plan type" ||
        normalized === "member id"
      ) {
        const valueSpan = spans[i + 1];
        if (valueSpan) {
          // Map back to canonical field names
          const canonical =
            normalized === "payer status" ? "Payer Status" :
            normalized === "coverage type" ? "Coverage Type" :
            normalized === "plan type" ? "Plan Type" :
            "Member ID";
          fields[canonical] = valueSpan.textContent?.trim() ?? "";
          i += 1;
        }
      }
    }

    const h1 = card.querySelector("h1");

    const result = {
      title: h1?.textContent?.trim() ?? "",
      payer: fields["Payer Status"] ?? "",
      coverage: fields["Coverage Type"] ?? "",
      plan: fields["Plan Type"] ?? "",
      id: fields["Member ID"] ?? "",
    };

    console.log(`[readRawCard] title="${result.title}" payer="${result.payer}" coverage="${result.coverage}" plan="${result.plan}" id="${result.id}"`);
    return result;
  });
}

/**
 * Returns true when a "Showing X - Y of Z" text exists in the context and the
 * Select button count equals Y - X + 1. When no such text exists, the check passes.
 */
async function showingCountMatches(ctx: Page | Frame, selectCount: number): Promise<boolean> {
  const showing = ctx.getByText(/Showing\s+\d+\s*[-–]\s*\d+\s+of\s+\d+/i);
  const showingCount = await showing.count().catch(() => 0);
  if (showingCount === 0) return true;

  for (let index = 0; index < showingCount; index += 1) {
    const text = await showing.nth(index).innerText({ timeout: 1_000 }).catch(() => "");
    const match = text.match(/Showing\s+(\d+)\s*[-–]\s*(\d+)\s+of\s+(\d+)/i);
    if (match) {
      const expected = Number(match[2]) - Number(match[1]) + 1;
      if (Number.isFinite(expected) && selectCount === expected) return true;
    }
  }
  return false;
}

/**
 * Polls until the results page is fully rendered:
 *   - Select button count is stable for at least 1000ms,
 *   - at least one card has non-empty payer, coverage, plan and id,
 *   - if a "Showing X - Y of Z" text exists, the count equals Y - X + 1.
 * On timeout, logs a warning and continues.
 */
async function waitForResultsReady(ctx: Page | Frame, page: Page, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let selectCount = 0;
  let stableSince = Date.now();
  let ready = false;

  while (Date.now() < deadline) {
    const currentCount = await ctx.getByRole("button", { name: "Select", exact: true }).count().catch(() => 0);
    if (currentCount !== selectCount) {
      selectCount = currentCount;
      stableSince = Date.now();
    }

    let cardsReady = currentCount > 0;
    if (cardsReady) {
      const selectBtns = ctx.getByRole("button", { name: "Select", exact: true });
      let readableCount = 0;
      for (let index = 0; index < currentCount; index += 1) {
        const card = await readRawCard(selectBtns.nth(index)).catch(() => null);
        if (card && card.payer && card.coverage && card.plan && card.id) {
          readableCount += 1;
        }
      }
      // Require at least one fully readable card, not all
      cardsReady = readableCount > 0;
      console.log(`[waitForResultsReady] ${readableCount}/${currentCount} cards fully readable`);
    }

    const stable = Date.now() - stableSince >= 1_000;
    const showingOk = await showingCountMatches(ctx, currentCount);

    if (cardsReady && stable) {
      if (!showingOk) {
        console.warn(`[waitForResultsReady] "Showing X-Y of Z" count mismatch (expected match, got ${currentCount} buttons); proceeding anyway`);
      }
      ready = true;
      break;
    }

    await page.waitForTimeout(300);
  }

  if (ready) {
    console.log(`[waitForResultsReady] results ready: ${selectCount} cards`);
  } else {
    console.warn(
      `[waitForResultsReady] Timed out after ${timeoutMs}ms waiting for results to be ready; continuing with ${selectCount} card(s)`
    );
  }
}

/**
 * Scans all Select buttons in the results context, reads their cards,
 * and returns the chosen button locator plus metadata.
 * 
 * Selection rules:
 * - Primary: isAllowedPlanType AND idMatches (if REQUIRED) AND payer=="primary" (if REQUIRED) AND coverage=="medical" (if REQUIRED)
 * - If multiple primary-qualify: take first in page order, warn
 * - Medicaid fallback: ONLY when NO card has allowed plan type. Requires payer=="primary" ONLY (no memberId, no coverage check)
 * - If allowed plan type present but no primary match: log failures per allowed-plan card, save no-match-results.png, return selected: false
 * - If both allowed plan type and Medicaid exist: ALWAYS prefer allowed plan type
 */
async function scanCards(
  ctx: Page | Frame,
  inputMemberId: string,
): Promise<{ chosenBtn: Locator | null; matchedBy: "primary" | "medicaid" | null; title: string }> {
  const selectBtns = ctx.getByRole("button", { name: "Select", exact: true });
  const count = await selectBtns.count();
  console.log(`[scanCards] Scanning ${count} Select button(s)`);

  // Read all cards and compute per-card decisions
  type CardDecision = {
    btn: Locator;
    card: RawCard;
    planTypePrimary: boolean;
    planTypeMedicaid: boolean;
    idOk: boolean;
    payerOk: boolean;
    coverageOk: boolean;
  };

  const allCards: CardDecision[] = [];
  const allowedPlanCards: CardDecision[] = [];
  const medicaidCards: CardDecision[] = [];

  for (let i = 0; i < count; i += 1) {
    const btn = selectBtns.nth(i);
    const card = await readRawCard(btn).catch(() => null);

    if (!card) {
      console.log(`[scanCards] Card ${i}: container not found or failed to read, skipping`);
      continue;
    }

    const normPlan = normalizeField(card.plan);
    const planTypePrimary = isAllowedPlanType(normPlan);
    const planTypeMedicaid = isMedicaidPlanType(normPlan);
    const idOk = idMatches(card.id, inputMemberId);
    const payerOk = normalizeField(card.payer) === "primary";
    const coverageOk = normalizeField(card.coverage) === "medical";

    // Log per-card decision line
    console.log(
      `[decision card ${i}] title="${card.title}" plan="${card.plan}" payer="${card.payer}" coverage="${card.coverage}" ` +
        `allowedPlan=${planTypePrimary} medicaid=${planTypeMedicaid} idOk=${idOk} payerOk=${payerOk} coverageOk=${coverageOk} ` +
        `| card id ${maskId(card.id)} vs wanted ${maskId(inputMemberId)}`,
    );

    const decision: CardDecision = { btn, card, planTypePrimary, planTypeMedicaid, idOk, payerOk, coverageOk };
    allCards.push(decision);
    if (planTypePrimary) allowedPlanCards.push(decision);
    if (planTypeMedicaid) medicaidCards.push(decision);
  }

  const hasAllowedPlan = allowedPlanCards.length > 0;
  const hasMedicaid = medicaidCards.length > 0;

  // Log summary
  console.log(`[scanCards] Summary: ${allCards.length} cards read, ${allowedPlanCards.length} with allowed plan type, ${medicaidCards.length} Medicaid`);

  // Helper: check if a card satisfies all primary rules
  function isPrimaryMatch(d: CardDecision): boolean {
    const idPass = REQUIRE_MEMBER_ID_MATCH ? d.idOk : true;
    const payerPass = REQUIRE_PAYER_PRIMARY ? d.payerOk : true;
    const coveragePass = REQUIRE_COVERAGE_MEDICAL ? d.coverageOk : true;
    return d.planTypePrimary && idPass && payerPass && coveragePass;
  }

  // Pass 1: Primary match - first card in page order that satisfies all rules
  let primaryMatch: CardDecision | null = null;
  for (const d of allCards) {
    if (isPrimaryMatch(d)) {
      primaryMatch = d;
      break;
    }
  }

  // If multiple primary-qualify, warn
  const primaryCandidates = allCards.filter(isPrimaryMatch);
  if (primaryCandidates.length > 1) {
    console.warn(`[scanCards] ${primaryCandidates.length} cards satisfy primary rules; selecting first in page order: "${primaryCandidates[0].card.title}"`);
  }

  // If allowed plan type exists but no primary match: log failures per allowed-plan card, screenshot, return no-match
  // DO NOT fall back to Medicaid if allowed plan type cards exist
  if (!primaryMatch && hasAllowedPlan) {
    for (const d of allowedPlanCards) {
      const failed: string[] = [];
      if (REQUIRE_MEMBER_ID_MATCH && !d.idOk) failed.push("memberId");
      if (REQUIRE_PAYER_PRIMARY && !d.payerOk) failed.push("payer");
      if (REQUIRE_COVERAGE_MEDICAL && !d.coverageOk) failed.push("coverage");
      if (failed.length > 0) {
        console.warn(`[scanCards] Allowed-plan card "${d.card.title}" failed: ${failed.join(", ")}`);
      }
    }
    // Screenshot for diagnosis
    try {
      await allowedPlanCards[0].btn.page().screenshot({ path: "no-match-results.png", fullPage: true });
      console.log("[scanCards] Saved no-match-results.png");
    } catch {
      // ignore screenshot errors
    }
    return { chosenBtn: null, matchedBy: null, title: "" };
  }

  // Pass 2: Medicaid fallback - ONLY when NO card has allowed plan type
  // Requires ONLY payer == "primary" (no memberId check, no coverage check)
  let medicaidMatch: CardDecision | null = null;
  if (!primaryMatch && !hasAllowedPlan && hasMedicaid) {
    for (const d of allCards) {
      if (d.planTypeMedicaid && d.payerOk) {
        medicaidMatch = d;
        break;
      }
    }
  }

  // No allowed plan type cards at all, and no medicaid match either
  if (!primaryMatch && !medicaidMatch && !hasAllowedPlan) {
    console.warn(`[scanCards] No cards with allowed plan type found. Plan types seen: ${allCards.map(d => `"${d.card.plan}"`).join(", ")}`);
  }

  if (primaryMatch) {
    console.log(`[MATCH primary] clicking Select on card "${primaryMatch.card.title}"`);
    return { chosenBtn: primaryMatch.btn, matchedBy: "primary", title: primaryMatch.card.title };
  }
  if (medicaidMatch) {
    console.log(`[MATCH medicaid] clicking Select on card "${medicaidMatch.card.title}" (fallback: no allowed plan type, payer=primary)`);
    return { chosenBtn: medicaidMatch.btn, matchedBy: "medicaid", title: medicaidMatch.card.title };
  }
  return { chosenBtn: null, matchedBy: null, title: "" };
}

/**
 * Clicks a Select button with a fallback to evaluate().
 * Waits 300ms first so the page settles after rendering the cards.
 * Verifies the click triggered navigation or state change.
 */
async function clickSelectButton(btn: Locator): Promise<void> {
  await btn.page().waitForTimeout(300);
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  const page = btn.page();
  const urlBefore = page.url();
  
  try {
    await btn.click({ timeout: 5_000 });
  } catch {
    await btn.evaluate((el) => (el as HTMLElement).click());
  }
  
  // Wait briefly and verify something changed (navigation, URL, or DOM)
  await page.waitForTimeout(1_000);
  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    console.log(`[clickSelectButton] Navigation detected: ${urlBefore} -> ${urlAfter}`);
  } else {
    // Check if we're still on results page (Select buttons still present)
    const stillOnResults = await page.getByRole("button", { name: "Select", exact: true }).count().catch(() => 0);
    if (stillOnResults > 0) {
      console.warn(`[clickSelectButton] Click may not have registered - still on results page with ${stillOnResults} Select button(s)`);
    } else {
      console.log("[clickSelectButton] Click registered (Select buttons gone)");
    }
  }
}

/**
 * Selects a policy on the UHC Member Search Results page.
 * Runs only on the Member Search Results page.
 *
 * Supports both call shapes:
 *   selectPolicy(page, memberId)
 *   selectPolicy(page, context, memberId)   // context is ignored
 *
 * @param page - Playwright page object (must be on Member Search Results page)
 * @param memberId - Member ID to match (trimmed, whitespace-collapsed, case-insensitive, non-alphanumeric stripped)
 * @returns SelectPolicyResult with selected status, context, and which pass matched
 */
export async function selectPolicy(page: Page, memberId: string): Promise<SelectPolicyResult>;
export async function selectPolicy(page: Page, context: unknown, memberId: string): Promise<SelectPolicyResult>;
export async function selectPolicy(page: Page, arg2: unknown, arg3?: string): Promise<SelectPolicyResult> {
  const memberId = typeof arg2 === "string" ? arg2 : arg3 ?? "";

  // Step 1: find results context
  const ctx = await findResultsContext(page);

  // Step 2: wait for the cards to be fully rendered before reading them
  await waitForResultsReady(ctx, page);

  // Step 3: scan all cards and choose
  const scanResult = await scanCards(ctx, memberId);

  if (scanResult.chosenBtn && scanResult.matchedBy) {
    const passName = scanResult.matchedBy === "primary" ? "primary" : "medicaid (fallback: no allowed plan type)";
    console.log(
      `[selectPolicy] Matched via ${passName}: "${scanResult.title}"`,
    );
    await clickSelectButton(scanResult.chosenBtn);
    return { selected: true, ctx, matchedBy: scanResult.matchedBy };
  }

  console.warn("[selectPolicy] No matching card found (primary pass + medicaid fallback)");
  return { selected: false, ctx };
}