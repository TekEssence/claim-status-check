const CLAIMS_SELECTORS = {
  memberIdFilter: "input[name='txtFilter2']",
  dateFilterType: "select#slctDateFilter[name='slctDateFilter']",
  startDate: "input#txtStartDate[name='txtStartDate']",
  endDate: "input#txtEndDate[name='txtEndDate']",
  openRecordIcon: "span[title='Open this record'][onclick*='claimDetail.asp']",
  nextPageImage: "img[alt='Next Page']",
  previousPageImage: "img[alt='Previous Page']",
  pageNumberInput: "input#txtPageNo[name='txtPageNo']",
  noClaimsText: "No claims were returned. Please use different search criteria.",
};

function extractClaimDetailUrlFromOnclick(onclick) {
  const text = String(onclick || "");
  const match = text.match(/openURLAsPopUp\(['"]([^'"]+)['"]\)/i);
  return match ? match[1].replace(/&amp;/g, "&") : "";
}

async function verifyClaimsSearchForm(page) {
  await page.locator(CLAIMS_SELECTORS.memberIdFilter).waitFor({ state: "visible", timeout: 30000 });
  await page.locator(CLAIMS_SELECTORS.dateFilterType).waitFor({ state: "visible", timeout: 30000 });
  await page.locator(CLAIMS_SELECTORS.startDate).waitFor({ state: "visible", timeout: 30000 });
  await page.locator(CLAIMS_SELECTORS.endDate).waitFor({ state: "visible", timeout: 30000 });
}

async function fillClaimsSearch(page, search) {
  await verifyClaimsSearchForm(page);

  await page.locator(CLAIMS_SELECTORS.dateFilterType).selectOption("0");
  await page.locator(CLAIMS_SELECTORS.startDate).fill(search.serviceDate);
  await page.locator(CLAIMS_SELECTORS.endDate).fill(search.serviceDate);
  await page.locator(CLAIMS_SELECTORS.memberIdFilter).fill(search.subscriberNo);
}

async function submitClaimsSearch(page) {
  const memberIdFilter = page.locator(CLAIMS_SELECTORS.memberIdFilter);

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    memberIdFilter.press("Enter"),
  ]);
}

async function searchClaims(page, search) {
  await fillClaimsSearch(page, search);
  await submitClaimsSearch(page);
  await waitForClaimsSearchToSettle(page);
}

async function getOpenRecordCount(page) {
  return page.locator(CLAIMS_SELECTORS.openRecordIcon).count();
}

async function getMatchingOpenRecordIndexes(page, criteria) {
  return page.locator("tr.dataGrid1Body").evaluateAll((rows, expected) => {
    const normalize = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const matches = [];
    let openRecordIndex = 0;

    for (const row of rows) {
      const openRecordIcon = row.querySelector("span[title='Open this record'][onclick*='claimDetail.asp']");
      if (!openRecordIcon) continue;

      const cells = Array.from(row.querySelectorAll("td"));
      const memberId = normalize(cells[4] ? cells[4].innerText : "");
      const serviceDate = normalize(cells[10] ? cells[10].innerText : "");

      if (memberId === expected.subscriberNo && serviceDate === expected.serviceDate) {
        matches.push(openRecordIndex);
      }

      openRecordIndex += 1;
    }

    return matches;
  }, criteria);
}

async function waitForClaimsSearchToSettle(page) {
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(
    ({ openRecordSelector, noClaimsText }) => {
      const hasOpenRecord = Boolean(document.querySelector(openRecordSelector));
      const bodyText = document.body ? document.body.innerText || "" : "";
      const hasNoClaims = bodyText.includes(noClaimsText);

      return hasOpenRecord || hasNoClaims;
    },
    {
      openRecordSelector: CLAIMS_SELECTORS.openRecordIcon,
      noClaimsText: CLAIMS_SELECTORS.noClaimsText,
    },
    { timeout: 10000 }
  ).catch(() => {});
}

async function getClaimDetailUrls(page) {
  return page.locator(CLAIMS_SELECTORS.openRecordIcon).evaluateAll((icons) =>
    icons
      .map((icon) => icon.getAttribute("onclick") || "")
      .map((onclick) => {
        const match = onclick.match(/openURLAsPopUp\(['"]([^'"]+)['"]\)/i);
        return match ? match[1].replace(/&amp;/g, "&") : "";
      })
      .filter(Boolean)
  );
}

async function getPaginationState(page) {
  const currentPageText = await page.locator(CLAIMS_SELECTORS.pageNumberInput).inputValue().catch(() => "");
  const currentPage = Number(currentPageText) || 1;
  const nextImage = page.locator(CLAIMS_SELECTORS.nextPageImage).first();
  const previousImage = page.locator(CLAIMS_SELECTORS.previousPageImage).first();
  const nextParentTag = await nextImage.evaluate((element) => element.parentElement ? element.parentElement.tagName.toLowerCase() : "").catch(() => "");
  const previousParentTag = await previousImage.evaluate((element) => element.parentElement ? element.parentElement.tagName.toLowerCase() : "").catch(() => "");
  const nextSrc = await nextImage.getAttribute("src").catch(() => "");
  const previousSrc = await previousImage.getAttribute("src").catch(() => "");

  return {
    currentPage,
    nextEnabled: nextParentTag === "a" && !/off\.gif/i.test(nextSrc || ""),
    previousEnabled: previousParentTag === "a" && !/off\.gif/i.test(previousSrc || ""),
  };
}

async function goToNextResultsPage(page) {
  const state = await getPaginationState(page);
  if (!state.nextEnabled) {
    return false;
  }

  const nextLink = page
    .locator("a")
    .filter({ has: page.locator(CLAIMS_SELECTORS.nextPageImage) })
    .first();

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    nextLink.click(),
  ]);

  await waitForClaimsSearchToSettle(page);
  return true;
}

async function openClaimDetailPopup(page, index = 0) {
  const icons = page.locator(CLAIMS_SELECTORS.openRecordIcon);
  const count = await icons.count();

  if (count === 0) {
    throw new Error("No claim detail eye icons were found after search.");
  }

  if (index < 0 || index >= count) {
    throw new Error(`Claim detail index ${index} is out of range. Found ${count} rows.`);
  }

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    icons.nth(index).click(),
  ]);

  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  return popup;
}

module.exports = {
  CLAIMS_SELECTORS,
  extractClaimDetailUrlFromOnclick,
  verifyClaimsSearchForm,
  fillClaimsSearch,
  submitClaimsSearch,
  searchClaims,
  waitForClaimsSearchToSettle,
  getOpenRecordCount,
  getMatchingOpenRecordIndexes,
  getClaimDetailUrls,
  getPaginationState,
  goToNextResultsPage,
  openClaimDetailPopup,
};
