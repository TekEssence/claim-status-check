const CLAIM_DETAIL_SELECTORS = {
  eobLink: "a[href^='claimEOB.asp?ID=']",
  claimInfoTable: "table#Table4",
  providerTable: "table#Table3",
  memberInfoTable: "table#Table5",
  serviceLineTable: "table#Table6",
};

function extractClaimStatusFromText(text) {
  const match = String(text || "").match(/\bStatus:\s*([^\r\n<]+)/i);
  return match ? match[1].trim() : "";
}

function extractLabelValueFromText(text, label) {
  const escapedLabel = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`\\b${escapedLabel}:\\s*([^\\r\\n<]+)`, "i"));
  return match ? match[1].trim() : "";
}

async function extractClaimDetailFallbackDetails(detailPage) {
  const bodyText = await detailPage.locator("body").innerText();

  return {
    claimNumber: extractLabelValueFromText(bodyText, "Claim Number"),
    claimStatus: extractClaimStatusFromText(bodyText),
    dateReceived: extractLabelValueFromText(bodyText, "Date Received"),
    rejectDate: extractLabelValueFromText(bodyText, "Reject Date"),
    datePaid: "",
    checkNumber: "",
    providerDetails: "",
    serviceLines: [],
    eobFound: false,
  };
}

async function extractClaimStatusFromDetailPopup(detailPage) {
  await detailPage.getByText(/Status:/i).first().waitFor({ state: "visible", timeout: 30000 });
  const bodyText = await detailPage.locator("body").innerText();
  return extractClaimStatusFromText(bodyText);
}

async function hasEobLink(detailPage) {
  return (await detailPage.locator(CLAIM_DETAIL_SELECTORS.eobLink).count()) > 0;
}

async function openEobFromClaimDetail(detailPage) {
  const eobLink = detailPage.locator(CLAIM_DETAIL_SELECTORS.eobLink).first();
  await eobLink.waitFor({ state: "visible", timeout: 30000 });

  await Promise.all([
    detailPage.waitForLoadState("domcontentloaded").catch(() => {}),
    eobLink.click(),
  ]);

  await detailPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
}

async function extractClaimStatus(detailPage) {
  await detailPage.getByText(/Status:/i).first().waitFor({ state: "visible", timeout: 30000 });
  const bodyText = await detailPage.locator("body").innerText();
  const status = extractClaimStatusFromText(bodyText);

  if (!status) {
    throw new Error("Claim status was not found on EOB page.");
  }

  return status;
}

async function extractKeyValueTable(page, tableSelector) {
  return page.locator(`${tableSelector} tr`).evaluateAll((rows) => {
    const values = {};

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) continue;

      const key = (cells[0].innerText || "")
        .replace(/\s+/g, " ")
        .replace(/:$/, "")
        .trim();
      const value = (cells[1].innerText || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

      if (key) {
        values[key] = value;
      }
    }

    return values;
  });
}

async function extractProviderDetails(page) {
  return page.locator(`${CLAIM_DETAIL_SELECTORS.providerTable} td`).evaluateAll((cells) =>
    cells
      .map((cell) => (cell.innerText || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
  );
}

async function extractMemberDetails(page) {
  const memberInfoTable = page.locator(CLAIM_DETAIL_SELECTORS.memberInfoTable);
  if ((await memberInfoTable.count()) === 0) {
    return {};
  }

  const details = await extractKeyValueTable(page, CLAIM_DETAIL_SELECTORS.memberInfoTable);

  return {
    memberId: details["Member ID"] || "",
    memberName: details["Member Name"] || "",
    memberBirthDate: details["Member's Birth Date"] || "",
    memberSex: details["Member's Sex"] || "",
    memberAddress: details["Member's Address"] || "",
    memberPhone: details["Member's Phone"] || "",
    memberHealthPlan: details["Member HealthPlan"] || "",
    memberHealthPlanBenefitOption: details["Member's HealthPlan Benefit Option"] || "",
    memberPcp: details["Member's PCP"] || "",
  };
}

function normalizeCellText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parseServiceCodeCell(value) {
  const text = normalizeCellText(value);
  const parts = text.split(/\s+-\s+/);

  return {
    serviceCode: parts[0] || text,
    serviceDescription: parts.slice(1).join(" - "),
  };
}

async function extractServiceLines(page) {
  const serviceLineTable = page.locator(CLAIM_DETAIL_SELECTORS.serviceLineTable);
  if ((await serviceLineTable.count()) === 0) {
    return [];
  }

  return serviceLineTable.locator("tr").evaluateAll((rows) => {
    const normalize = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const lines = [];
    let currentLine = null;

    const parseServiceCode = (value) => {
      const text = normalize(value);
      const parts = text.split(/\s+-\s+/);
      return {
        serviceCode: parts[0] || text,
        serviceDescription: parts.slice(1).join(" - "),
      };
    };

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (!cells.length) continue;

      const cellTexts = cells.map((cell) => normalize(cell.innerText));
      const isServiceLineRow = cells.length >= 12 && /^\d/.test(cellTexts[0]);
      const isDetailRow = cells.length === 1 && cells[0].getAttribute("colspan");

      if (isServiceLineRow) {
        if (currentLine) {
          lines.push(currentLine);
        }

        const parsed = parseServiceCode(cellTexts[0]);
        currentLine = {
          serviceCode: parsed.serviceCode,
          serviceDescription: parsed.serviceDescription,
          quantity: cellTexts[1] || "",
          serviceDate: cellTexts[2] || "",
          billed: cellTexts[3] || "",
          contract: cellTexts[4] || "",
          disallowedDenied: cellTexts[5] || "",
          copayCoinsurance: cellTexts[6] || "",
          deductible: cellTexts[7] || "",
          adjustment: cellTexts[8] || "",
          withholdRiskPool: cellTexts[9] || "",
          paid: cellTexts[10] || "",
          interest: cellTexts[11] || "",
          details: [],
        };
        continue;
      }

      if (isDetailRow && currentLine) {
        const detail = cellTexts[0];
        if (detail) {
          currentLine.details.push(detail);
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.map((line) => ({
      ...line,
      details: line.details.join("\n"),
    }));
  });
}

async function extractEobDetails(detailPage) {
  await detailPage.locator(CLAIM_DETAIL_SELECTORS.claimInfoTable).waitFor({ state: "visible", timeout: 30000 });

  const claimInfo = await extractKeyValueTable(detailPage, CLAIM_DETAIL_SELECTORS.claimInfoTable);
  const providerDetails = await extractProviderDetails(detailPage);
  const memberDetails = await extractMemberDetails(detailPage);
  const serviceLines = await extractServiceLines(detailPage);
  const bodyText = await detailPage.locator("body").innerText();

  return {
    ...memberDetails,
    claimNumber: claimInfo["Claim Number"] || "",
    claimStatus: claimInfo["Claim Status"] || extractClaimStatusFromText(bodyText),
    dateReceived: claimInfo["Date Received"] || "",
    datePaid: claimInfo["Date Paid"] || "",
    checkNumber: claimInfo["Check Number"] || "",
    providerDetails,
    serviceLines,
    eobFound: true,
  };
}

async function openEobAndExtractDetails(detailPage) {
  const popupStatus = await extractClaimStatusFromDetailPopup(detailPage);
  const popupText = await detailPage.locator("body").innerText();
  const rejectDate = extractLabelValueFromText(popupText, "Reject Date");

  if (!(await hasEobLink(detailPage))) {
    return extractClaimDetailFallbackDetails(detailPage);
  }

  await openEobFromClaimDetail(detailPage);
  const details = await extractEobDetails(detailPage);

  return {
    ...details,
    claimStatus: popupStatus || details.claimStatus,
    rejectDate,
  };
}

module.exports = {
  CLAIM_DETAIL_SELECTORS,
  extractClaimStatusFromText,
  extractLabelValueFromText,
  extractClaimDetailFallbackDetails,
  extractClaimStatusFromDetailPopup,
  hasEobLink,
  openEobFromClaimDetail,
  extractClaimStatus,
  extractKeyValueTable,
  extractProviderDetails,
  extractMemberDetails,
  extractServiceLines,
  extractEobDetails,
  openEobAndExtractDetails,
};
