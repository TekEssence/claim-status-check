"use strict";

const logger = require("../utils/logger");
const { humanDelay } = require("../utils/browser");
const { getClaimStatusFrame } = require("./navigation.page");

const SELECTORS = {
  returnToResults: "a:has-text('Return to Results')",
  expandAllButton: "button:has-text('Expand All')",
  expandLineButton: "button[title='Toggle Row Expanded']",
  showMoreButton: "button:has-text('Show more')",
  codesTable: "table#codesTable",
  hipaaLineLevelTable: "table#lineLevelTable"
};

async function safeInnerText(locator, timeoutMs = 3000) {
  return locator.innerText({ timeout: timeoutMs }).then((text) => text.trim()).catch(() => "");
}

async function readExactInfoPanelValue(frame, labelText, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await frame.evaluate((targetId) => {
      function isVisible(element) {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }

      const targetTestId = `test${targetId}Panel`;
      const panels = Array.from(document.querySelectorAll(".info-panel-display, [data-testid]"))
        .filter((panel) => {
          return isVisible(panel)
            && (panel.id === targetId || panel.getAttribute("data-testid") === targetTestId);
        });

      for (const panel of panels) {
        const values = Array.from(panel.querySelectorAll("p"))
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim());

        if (values[1] && values[1] !== "--") {
          return values[1];
        }
      }

      return "";
    }, labelText).catch(() => "");

    if (value) {
      return value;
    }

    await humanDelay(250, 500);
  }

  return "";
}

async function readColumnHeaders(scope) {
  const headers = await scope.locator("thead th").evaluateAll((nodes) => nodes.map((node) => node.textContent || "")).catch(() => []);
  return headers.map((header) => header.replace(/\s+/g, " ").trim().toLowerCase());
}

function cellByHeader(cells, headers, headerName) {
  const target = String(headerName || "").toLowerCase();
  const index = headers.findIndex((header) => header === target || header.includes(target));
  return index >= 0 ? cells[index] || "" : "";
}

function cellByExactHeader(cells, headers, headerName) {
  const target = String(headerName || "").toLowerCase();
  const index = headers.findIndex((header) => header === target);
  return index >= 0 ? cells[index] || "" : "";
}

function cellByAnyHeader(cells, headers, headerNames, fallbackIndex) {
  for (const headerName of headerNames) {
    const value = cellByHeader(cells, headers, headerName);
    if (value) {
      return value;
    }
  }

  return Number.isInteger(fallbackIndex) ? cells[fallbackIndex] || "" : "";
}

function cellByAnyExactHeader(cells, headers, headerNames, fallbackIndex) {
  for (const headerName of headerNames) {
    const value = cellByExactHeader(cells, headers, headerName);
    if (value) {
      return value;
    }
  }

  return Number.isInteger(fallbackIndex) ? cells[fallbackIndex] || "" : "";
}

function looksLikeProcedureCode(value) {
  return /^[A-Z]?\d{4,5}[A-Z]?$/i.test(String(value || "").trim());
}

function looksLikeDate(value) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(String(value || "").trim());
}

function normalizeRemarkCode(value) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  return looksLikeDate(cleaned) ? "" : cleaned;
}

function xpathLiteral(value) {
  const text = String(value || "");
  if (!text.includes("'")) {
    return `'${text}'`;
  }
  if (!text.includes('"')) {
    return `"${text}"`;
  }
  return `concat('${text.replace(/'/g, "',\"'\",'")}')`;
}

async function findTableWithHeaders(scope, requiredHeaders) {
  const tables = scope.locator("table");
  const tableCount = await tables.count();

  for (let index = 0; index < tableCount; index += 1) {
    const table = tables.nth(index);
    const headers = await readColumnHeaders(table);
    const hasAllHeaders = requiredHeaders.every((required) => {
      const normalizedRequired = required.toLowerCase();
      return headers.some((header) => header === normalizedRequired || header.includes(normalizedRequired));
    });

    if (hasAllHeaders) {
      return table;
    }
  }

  return null;
}

async function waitForLineLevelRows(page, options = {}) {
  const frame = await getClaimStatusFrame(page);
  const hipaa = options.hipaa === true;
  const deadline = Date.now() + (options.timeoutMs || 5000);
  const findMemberLineTable = async () => {
    return await findTableWithHeaders(frame, ["Procedure Code", "Service Dates"])
      || await findTableWithHeaders(frame, ["Proc", "Service Dates", "Billed", "Paid"]);
  };

  while (Date.now() < deadline) {
    const table = hipaa
      ? frame.locator(SELECTORS.hipaaLineLevelTable).first()
      : await findMemberLineTable();

    const tableVisible = table && await table.isVisible({ timeout: 500 }).catch(() => false);
    if (tableVisible) {
      const procedureCellCount = await table.locator("p[id^='procedureCode-']").count().catch(() => 0);
      const rowCount = await table.locator("tbody tr").count().catch(() => 0);
      if (procedureCellCount > 0 || rowCount > 0) {
        return table;
      }
    }

    await humanDelay(500, 900);
  }

  return hipaa
    ? frame.locator(SELECTORS.hipaaLineLevelTable).first()
    : await findMemberLineTable();
}

async function waitForClaimDetailPage(page) {
  const frame = await getClaimStatusFrame(page);
  await Promise.race([
    frame.getByText("Claim Number", { exact: false }).first().waitFor({ state: "visible", timeout: 10000 }),
    frame.getByText("Claim Status", { exact: false }).first().waitFor({ state: "visible", timeout: 10000 }),
    frame.getByText("Line Level Information", { exact: false }).first().waitFor({ state: "visible", timeout: 10000 }),
    frame.locator(SELECTORS.returnToResults).first().waitFor({ state: "visible", timeout: 10000 })
  ]);
}

async function getLabelValue(page, labelText) {
  const frame = await getClaimStatusFrame(page);
  const directPanelValue = await readExactInfoPanelValue(frame, labelText, 2000);

  if (directPanelValue) {
    logger.info(`Extracted direct info panel "${labelText}" value="${directPanelValue}"`);
    return directPanelValue;
  }

  if (["Claim Number", "Check Number"].includes(labelText)) {
    logger.warn(`Exact info panel "${labelText}" was not found. Skipping broad fallback to avoid reading table headers.`);
    return "";
  }

  const panels = frame.locator(`xpath=//*[@id=${xpathLiteral(labelText)} and contains(@class,'info-panel-display')]`);
  const panelCount = await panels.count().catch(() => 0);

  for (let index = 0; index < panelCount; index += 1) {
    const panel = panels.nth(index);
    if (!await panel.isVisible({ timeout: 1000 }).catch(() => false)) {
      continue;
    }

    const valueLocator = panel.locator("p").nth(1);
    await valueLocator.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    const panelValue = await safeInnerText(valueLocator, 5000);
    if (panelValue && panelValue !== "--") {
      logger.info(`Extracted info panel "${labelText}" value="${panelValue}"`);
      return panelValue;
    }
  }

  const domValue = await frame.evaluate((targetLabel) => {
    function isVisible(element) {
      if (!element) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function clean(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function findValueNearLabel(labelElement) {
      const containers = [
        labelElement.parentElement,
        labelElement.closest(".info-panel-display"),
        labelElement.closest("tr"),
        labelElement.closest(".MuiBox-root"),
        labelElement.closest("div")
      ].filter(Boolean);

      for (const container of containers) {
        const cells = Array.from(container.querySelectorAll("td, p, span, div"))
          .filter((node) => node !== labelElement && isVisible(node))
          .map((node) => clean(node.textContent))
          .filter(Boolean)
          .filter((text) => text !== targetLabel);

        const value = cells.find((text) => !text.toLowerCase().startsWith(targetLabel.toLowerCase()));
        if (value) {
          return value;
        }

        const containerText = clean(container.textContent);
        const withoutLabel = clean(containerText.replace(targetLabel, ""));
        if (withoutLabel && withoutLabel !== containerText) {
          return withoutLabel;
        }
      }

      let sibling = labelElement.nextElementSibling;
      while (sibling) {
        if (isVisible(sibling)) {
          const text = clean(sibling.textContent);
          if (text && text !== targetLabel) {
            return text;
          }
        }
        sibling = sibling.nextElementSibling;
      }

      return "";
    }

    const candidates = Array.from(document.querySelectorAll("p, span, div, td, th"))
      .filter(isVisible)
      .filter((element) => clean(element.textContent) === targetLabel);

    for (const candidate of candidates) {
      const value = findValueNearLabel(candidate);
      if (value && value !== "--") {
        return value;
      }
    }

    return "";
  }, labelText).catch(() => "");

  if (domValue) {
    logger.info(`Extracted label "${labelText}" value="${domValue}" using DOM fallback`);
    return domValue;
  }

  const label = frame.getByText(labelText, { exact: false }).first();
  const value = label.locator("xpath=following::*[self::p or self::span][1]");
  return safeInnerText(value);
}

async function getInfoPanelValue(page, labelText) {
  const frame = await getClaimStatusFrame(page);
  const directPanelValue = await readExactInfoPanelValue(frame, labelText, 2000);

  if (directPanelValue) {
    logger.info(`Extracted direct HIPAA info panel "${labelText}" value="${directPanelValue}"`);
    return directPanelValue;
  }

  const panels = frame.locator(`xpath=//*[@id=${xpathLiteral(labelText)} and contains(@class,'info-panel-display')]`);
  const panelCount = await panels.count().catch(() => 0);

  for (let index = 0; index < panelCount; index += 1) {
    const panel = panels.nth(index);
    if (!await panel.isVisible({ timeout: 1000 }).catch(() => false)) {
      continue;
    }

    const valueLocator = panel.locator("p").nth(1);
    await valueLocator.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    const panelValue = await safeInnerText(valueLocator, 5000);
    if (panelValue && panelValue !== "--") {
      logger.info(`Extracted HIPAA info panel "${labelText}" value="${panelValue}"`);
      return panelValue;
    }
  }

  return getLabelValue(page, labelText);
}

async function getClaimNumber(page) {
  return getLabelValue(page, "Claim Number");
}

async function getClaimStatus(page) {
  const frame = await getClaimStatusFrame(page);
  const badge = frame.locator(".badge").first();
  if (await badge.isVisible({ timeout: 2000 }).catch(() => false)) {
    return safeInnerText(badge);
  }
  return getLabelValue(page, "Claim Status");
}

async function extractInProcess(page, status) {
  return {
    type: "in_process",
    claimNumber: await getClaimNumber(page),
    claimStatus: status,
    receivedDate: await getLabelValue(page, "Received Date")
  };
}

async function readExpandedAmounts(page) {
  const frame = await getClaimStatusFrame(page);
  const labels = ["Coinsurance", "Copay", "Deductible"];
  const result = {};

  for (const label of labels) {
    const labelLocator = frame.getByText(label, { exact: true }).last();
    const value = await safeInnerText(labelLocator.locator("xpath=following::*[self::p][1]"), 2000);
    result[label.toLowerCase()] = value;
  }

  return result;
}

async function expandAllMemberLines(tableScope) {
  const expandAll = tableScope.locator(SELECTORS.expandAllButton).first();
  if (await expandAll.isVisible({ timeout: 2000 }).catch(() => false)) {
    await expandAll.click({ force: true });
    await humanDelay(500, 900);
    logger.info("Clicked Member line-level Expand All button");
    return true;
  }

  logger.info("Member line-level Expand All button not visible; falling back to per-row expand buttons");
  return false;
}

async function readExpandedLabelValue(row, page, labelText) {
  const fromFollowingDetailRows = await row.evaluate((rowElement, targetLabel) => {
    function clean(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function readValueFromContainer(container) {
      const labels = Array.from(container.querySelectorAll("p, div, span, th, td"));
      const label = labels.find((node) => clean(node.textContent) === targetLabel);
      if (!label) {
        return "";
      }

      let sibling = label.nextElementSibling;
      while (sibling) {
        const value = clean(sibling.textContent);
        if (value && value !== targetLabel) {
          return value;
        }
        sibling = sibling.nextElementSibling;
      }

      const parent = label.parentElement;
      if (parent) {
        const valueNodes = Array.from(parent.querySelectorAll("p, div, span"))
          .filter((node) => node !== label)
          .map((node) => clean(node.textContent))
          .filter(Boolean)
          .filter((value) => value !== targetLabel);

        if (valueNodes.length > 0) {
          return valueNodes[valueNodes.length - 1];
        }
      }

      return "";
    }

    let siblingRow = rowElement.nextElementSibling;
    while (siblingRow) {
      if (siblingRow.querySelector("p[id^='procedureCode-']")) {
        break;
      }

      const value = readValueFromContainer(siblingRow);
      if (value) {
        return value;
      }

      siblingRow = siblingRow.nextElementSibling;
    }

    return "";
  }, labelText).catch(() => "");

  if (fromFollowingDetailRows.trim()) {
    return fromFollowingDetailRows.trim();
  }

  const expandedSibling = row.locator("xpath=following-sibling::tr[1]");
  const fromSibling = await expandedSibling
    .getByText(labelText, { exact: true })
    .locator("xpath=following::*[self::p or self::div][1]")
    .innerText({ timeout: 1500 })
    .catch(() => "");

  if (fromSibling.trim()) {
    return fromSibling.trim();
  }

  const frame = await getClaimStatusFrame(page);
  return frame
    .getByText(labelText, { exact: true })
    .last()
    .locator("xpath=following::*[self::p or self::div][1]")
    .innerText({ timeout: 1500 })
    .then((text) => text.trim())
    .catch(() => "");
}

async function readFirstExpandedLabelValue(row, page, labelTexts) {
  for (const labelText of labelTexts) {
    const value = await readExpandedLabelValue(row, page, labelText);
    if (value.trim()) {
      return value.trim();
    }
  }

  return "";
}

async function readExpandedMuiGridLabelValue(row, page, labelTexts) {
  const fromRowExpansion = await row.evaluate((rowElement, labels) => {
    function clean(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function matchesLabel(value) {
      return labels.some((label) => clean(value).toLowerCase() === clean(label).toLowerCase());
    }

    function readFromRoot(root) {
      const gridItems = Array.from(root.querySelectorAll("div[class*='MuiGrid-root']"));
      for (const gridItem of gridItems) {
        const children = Array.from(gridItem.children);
        const label = children.find((child) => matchesLabel(child.textContent));
        if (!label) {
          continue;
        }

        const value = children
          .filter((child) => child !== label)
          .map((child) => clean(child.textContent))
          .find((text) => text && !matchesLabel(text));

        if (value) {
          return value;
        }
      }

      const labelNode = Array.from(root.querySelectorAll("p, div, span")).find((node) => matchesLabel(node.textContent));
      if (labelNode) {
        let sibling = labelNode.nextElementSibling;
        while (sibling) {
          const value = clean(sibling.textContent);
          if (value && !matchesLabel(value)) {
            return value;
          }
          sibling = sibling.nextElementSibling;
        }
      }

      return "";
    }

    const currentRowValue = readFromRoot(rowElement);
    if (currentRowValue) {
      return currentRowValue;
    }

    let siblingRow = rowElement.nextElementSibling;
    while (siblingRow) {
      if (siblingRow.querySelector("p[id^='procedureCode-']")) {
        break;
      }

      const value = readFromRoot(siblingRow);
      if (value) {
        return value;
      }

      siblingRow = siblingRow.nextElementSibling;
    }

    return "";
  }, labelTexts).catch(() => "");

  if (fromRowExpansion.trim()) {
    return fromRowExpansion.trim();
  }

  const frame = await getClaimStatusFrame(page);
  return frame.evaluate((labels) => {
    function clean(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function matchesLabel(value) {
      return labels.some((label) => clean(value).toLowerCase() === clean(label).toLowerCase());
    }

    const gridItems = Array.from(document.querySelectorAll("div[class*='MuiGrid-root']"));
    for (let index = gridItems.length - 1; index >= 0; index -= 1) {
      const children = Array.from(gridItems[index].children);
      const label = children.find((child) => matchesLabel(child.textContent));
      if (!label) {
        continue;
      }

      const value = children
        .filter((child) => child !== label)
        .map((child) => clean(child.textContent))
        .find((text) => text && !matchesLabel(text));

      if (value) {
        return value;
      }
    }

    return "";
  }, labelTexts).catch(() => "");
}

async function extractLineRows(page) {
  const frame = await getClaimStatusFrame(page);
  const tableScope = await waitForLineLevelRows(page, { timeoutMs: 15000 }) || frame;
  const headers = await readColumnHeaders(tableScope);
  const expandedAll = await expandAllMemberLines(tableScope);

  const procedureCodes = tableScope.locator("p[id^='procedureCode-']");
  const count = await procedureCodes.count();
  const lines = [];
  logger.info(`Member line-level table scan: cpt_rows=${count}, headers="${headers.join(" | ")}"`);

  if (count === 0) {
    const rows = tableScope.locator("tbody tr");
    const rowCount = await rows.count().catch(() => 0);
    logger.info(`Member plain line-level table scan: rows=${rowCount}, headers="${headers.join(" | ")}"`);

    for (let index = 0; index < rowCount; index += 1) {
      const cells = (await rows.nth(index).locator("td").allTextContents())
        .map((cell) => cell.replace(/\s+/g, " ").trim());
      const procedureCode = cellByAnyHeader(cells, headers, ["procedure code", "proc"], 1)
        || cells.find(looksLikeProcedureCode)
        || "";

      if (!procedureCode.trim()) {
        continue;
      }

      const line = {
        procedureCode: procedureCode.trim(),
        status: cellByAnyExactHeader(cells, headers, ["status"]),
        serviceDates: cellByAnyExactHeader(cells, headers, ["service dates"], 0),
        paid: cellByAnyExactHeader(cells, headers, ["paid", "paid amount"], 9),
        billed: cellByAnyExactHeader(cells, headers, ["billed", "billed amount"], 7),
        allowed: cellByAnyExactHeader(cells, headers, ["allowed", "allowed amount"], 8),
        hipaaCodes: cellByAnyExactHeader(cells, headers, ["hipaa codes"]),
        modifier: cellByAnyExactHeader(cells, headers, ["modifier", "mods"], 3),
        quantity: cellByAnyExactHeader(cells, headers, ["quantity", "qty"], 4),
        coinsurance: cellByAnyExactHeader(cells, headers, ["coinsurance", "coins", "coinsurance amount"], 11),
        copay: cellByAnyExactHeader(cells, headers, ["copay", "copay amount"]),
        deductible: cellByAnyExactHeader(cells, headers, ["deductible", "deductible amount"], 12),
        reasonRemarkCode: cellByAnyExactHeader(cells, headers, ["reason/remark codes", "reason/remark"], 6)
      };

      logger.info(
        `Member plain CPT line parsed: procedure="${line.procedureCode}", billed="${line.billed}", allowed="${line.allowed}", paid="${line.paid}", coinsurance="${line.coinsurance}", deductible="${line.deductible}", remark="${line.reasonRemarkCode}"`
      );
      lines.push(line);
    }

    logger.info(`Extracted ${lines.length} CPT line(s) from plain Member claim detail table`);
    return lines;
  }

  for (let index = 0; index < count; index += 1) {
    const procedureCodeElement = procedureCodes.nth(index);
    const row = procedureCodeElement.locator("xpath=ancestor::tr[1]");
    const cells = (await row.locator("td").allTextContents()).map((cell) => cell.replace(/\s+/g, " ").trim());
    const procedureCode = await safeInnerText(procedureCodeElement, 1000)
      || cellByHeader(cells, headers, "procedure code")
      || cells.find(looksLikeProcedureCode)
      || "";
    if (!procedureCode.trim()) {
      continue;
    }

    const expandButton = row.locator(SELECTORS.expandLineButton);
    if (!expandedAll && await expandButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await expandButton.click();
      await humanDelay(300, 700);
    }

    const expanded = {
      coinsurance: await readExpandedLabelValue(row, page, "Coinsurance"),
      copay: await readExpandedLabelValue(row, page, "Copay"),
      deductible: await readExpandedLabelValue(row, page, "Deductible")
    };
    const reasonRemarkCode = await readExpandedLabelValue(row, page, "Reason/Remark Codes");
    const tableCoinsurance = cellByAnyExactHeader(cells, headers, ["coinsurance", "coins", "coinsurance amount"]);
    const tableCopay = cellByAnyExactHeader(cells, headers, ["copay", "copay amount"]);
    const tableDeductible = cellByAnyExactHeader(cells, headers, ["deductible", "deductible amount"]);
    const tableReasonRemarkCode = normalizeRemarkCode(cellByAnyExactHeader(cells, headers, ["reason/remark codes", "reason/remark"]));
    const expandedReasonRemarkCode = normalizeRemarkCode(reasonRemarkCode);

    lines.push({
      procedureCode: procedureCode.trim(),
      status: cellByHeader(cells, headers, "status") || cells[1] || "",
      serviceDates: cellByHeader(cells, headers, "service dates") || cells[2] || "",
      paid: cellByHeader(cells, headers, "paid") || cells[5] || "",
      billed: cellByHeader(cells, headers, "billed") || cells[6] || "",
      allowed: cellByHeader(cells, headers, "allowed") || "",
      hipaaCodes: cellByHeader(cells, headers, "hipaa codes") || cells[7] || "",
      modifier: cellByHeader(cells, headers, "modifier") || cells[8] || "",
      quantity: cellByHeader(cells, headers, "quantity") || cells[9] || "",
      coinsurance: tableCoinsurance || expanded.coinsurance || cellByHeader(cells, headers, "coinsurance") || cellByHeader(cells, headers, "coins") || "",
      copay: tableCopay || expanded.copay || "",
      deductible: tableDeductible || expanded.deductible || "",
      reasonRemarkCode: tableReasonRemarkCode || expandedReasonRemarkCode || normalizeRemarkCode(cellByHeader(cells, headers, "reason/remark codes"))
    });
  }

  logger.info(`Extracted ${lines.length} CPT line(s) from claim detail page`);
  return lines;
}

async function extractPaid(page, status) {
  logger.info("Extracting PAID claim detail");
  const claimNumber = await getClaimNumber(page);
  const checkNumber = await getLabelValue(page, "Check Number");
  const checkDate = await getLabelValue(page, "Check Date");
  const lines = await extractLineRows(page);
  for (const line of lines) {
    line.remarkCode = line.remarkCode || line.reasonRemarkCode || "";
    line.description = line.description || (line.remarkCode ? await getRemarkDescription(page, line.remarkCode) : "");
  }
  logger.info(`Member PAID header values: claim="${claimNumber}", check_number="${checkNumber}", check_date="${checkDate}"`);

  return {
    type: "paid",
    claimNumber,
    claimStatus: status,
    checkNumber,
    checkDate,
    lines
  };
}

async function getRemarkDescription(page, remarkCode) {
  if (!remarkCode) {
    return "";
  }

  const frame = await getClaimStatusFrame(page);
  const codesTable = frame.locator(SELECTORS.codesTable).first();
  const searchScope = await codesTable.isVisible({ timeout: 2000 }).catch(() => false) ? codesTable : frame;
  const showMoreButtons = searchScope.locator(SELECTORS.showMoreButton);
  const count = await showMoreButtons.count();
  for (let index = 0; index < count; index += 1) {
    await showMoreButtons.nth(index).click().catch(() => {});
  }

  const codeRows = searchScope.locator("tr").filter({ has: searchScope.locator("td", { hasText: remarkCode }) });
  const codeRowCount = await codeRows.count();

  for (let index = 0; index < codeRowCount; index += 1) {
    const row = codeRows.nth(index);
    const cells = row.locator("td");
    const type = await safeInnerText(cells.nth(0), 1000);
    const code = await safeInnerText(cells.nth(1), 1000);

    if (code.trim().toUpperCase() === remarkCode.trim().toUpperCase() && /remark/i.test(type)) {
      return safeInnerText(cells.nth(2), 3000);
    }
  }

  const fallbackCodeCell = frame.locator("td", { hasText: remarkCode }).last();
  const fallbackRow = fallbackCodeCell.locator("xpath=ancestor::tr[1]");
  return safeInnerText(fallbackRow.locator("td").nth(2), 3000);
}

async function getHipaaRemarkDescription(page, remarkCode) {
  if (!remarkCode) {
    return "";
  }

  const frame = await getClaimStatusFrame(page);
  const showMoreButtons = frame.locator(SELECTORS.showMoreButton);
  const count = await showMoreButtons.count();
  for (let index = 0; index < count; index += 1) {
    await showMoreButtons.nth(index).click().catch(() => {});
  }

  const requestedCodes = String(remarkCode || "")
    .split(":")
    .map((code) => code.trim())
    .filter(Boolean);
  const descriptions = [];

  const tables = frame.locator("table");
  const tableCount = await tables.count();
  for (const requestedCode of requestedCodes) {
    let description = "";

    for (let tableIndex = 0; tableIndex < tableCount && !description; tableIndex += 1) {
      const table = tables.nth(tableIndex);
      const headerText = await table.locator("thead").innerText({ timeout: 1000 }).catch(() => "");
      if (!/type/i.test(headerText) || !/code/i.test(headerText) || !/description/i.test(headerText)) {
        continue;
      }

      const rows = table.locator("tbody > tr");
      const rowCount = await rows.count();
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const cells = rows.nth(rowIndex).locator("td");
        const code = await safeInnerText(cells.nth(1), 1000);

        if (code.trim().toUpperCase() === requestedCode.toUpperCase()) {
          description = await safeInnerText(cells.nth(2), 3000);
          break;
        }
      }
    }

    if (description) {
      descriptions.push(`${requestedCode}: ${description}`);
    } else {
      logger.info(`HIPAA remark description not found in a Type/Code/Description table for code "${requestedCode}".`);
    }
  }

  return descriptions.join(" | ");
}


async function extractDenied(page, status) {
  logger.info("Extracting DENIED claim detail");
  const baseLines = await extractLineRows(page);
  if (baseLines.length === 0) {
    logger.warn("DENIED extraction found 0 CPT line rows on Member detail page.");
  }
  const lines = [];

  for (const item of baseLines) {
    const remarkCode = item.reasonRemarkCode || "";
    if (!remarkCode.trim()) {
      logger.warn(`DENIED line ${item.procedureCode || "unknown"} did not include a Reason/Remark Code.`);
    }
    lines.push({
      procedureCode: item.procedureCode,
      remarkCode: remarkCode.trim(),
      description: await getRemarkDescription(page, remarkCode.trim())
    });
  }

  return {
    type: "denied",
    claimNumber: await getClaimNumber(page),
    claimStatus: status,
    lines
  };
}

async function extractHipaaLineRows(page, options = {}) {
  const preferExpandedReasonRemarkCode = options.preferExpandedReasonRemarkCode === true;
  const frame = await getClaimStatusFrame(page);
  const lineTable = await waitForLineLevelRows(page, { hipaa: true, timeoutMs: 15000 }) || frame.locator(SELECTORS.hipaaLineLevelTable).first();
  const tableScope = await lineTable.isVisible({ timeout: 3000 }).catch(() => false) ? lineTable : frame;
  const headers = await readColumnHeaders(tableScope);
  const procedureCodes = tableScope.locator("p[id^='procedureCode-']");
  const count = await procedureCodes.count();
  const lines = [];

  if (count === 0) {
    const rows = tableScope.locator("tbody tr");
    const rowCount = await rows.count().catch(() => 0);
    logger.info(`HIPAA plain line-level table scan: rows=${rowCount}, headers="${headers.join(" | ")}"`);

    for (let index = 0; index < rowCount; index += 1) {
      const cells = (await rows.nth(index).locator("td").allTextContents())
        .map((cell) => cell.replace(/\s+/g, " ").trim());
      const procedureCode = cellByAnyExactHeader(cells, headers, ["procedure code", "proc"], 2)
        || cells.find(looksLikeProcedureCode)
        || "";

      if (!procedureCode.trim()) {
        continue;
      }

      const line = {
        status: cellByAnyExactHeader(cells, headers, ["status"], 0),
        serviceDates: cellByAnyExactHeader(cells, headers, ["service dates"], 1),
        procedureCode: procedureCode.trim(),
        paid: cellByAnyExactHeader(cells, headers, ["paid", "paid amount"], 3),
        billed: cellByAnyExactHeader(cells, headers, ["billed", "billed amount"], 4),
        revenueCode: cellByAnyExactHeader(cells, headers, ["revenue code", "rev"], 5),
        reasonRemarkCode: normalizeRemarkCode(cellByAnyExactHeader(cells, headers, ["hipaa codes", "reason/remark codes", "reason/remark"], 6)),
        modifier: cellByAnyExactHeader(cells, headers, ["modifier"], 7),
        quantity: cellByAnyExactHeader(cells, headers, ["quantity", "qty"], 8),
        allowed: cellByAnyExactHeader(cells, headers, ["allowed", "allowed amount"]),
        coinsurance: cellByAnyExactHeader(cells, headers, ["coinsurance", "coinsurance amount"]),
        copay: cellByAnyExactHeader(cells, headers, ["copay", "copay amount"]),
        deductible: cellByAnyExactHeader(cells, headers, ["deductible", "deductible amount"])
      };

      logger.info(
        `HIPAA plain CPT line parsed: status="${line.status}", procedure="${line.procedureCode}", billed="${line.billed}", paid="${line.paid}", remark="${line.reasonRemarkCode}"`
      );
      lines.push(line);
    }

    logger.info(`Extracted ${lines.length} HIPAA CPT line(s) from plain claim detail table`);
    return lines;
  }

  for (let index = 0; index < count; index += 1) {
    const procedureCodeElement = procedureCodes.nth(index);
    const row = procedureCodeElement.locator("xpath=ancestor::tr[1]");
    const cells = (await row.locator("td").allTextContents()).map((cell) => cell.replace(/\s+/g, " ").trim());
    const procedureCode = await safeInnerText(procedureCodeElement, 1000)
      || cellByHeader(cells, headers, "procedure code")
      || cells.find(looksLikeProcedureCode)
      || "";
    if (!procedureCode.trim()) {
      continue;
    }

    const expandButton = row.locator(SELECTORS.expandLineButton);
    if (await expandButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await expandButton.click();
      await humanDelay(300, 700);
    }

    const expandedReasonRemarkCode = preferExpandedReasonRemarkCode
      ? normalizeRemarkCode(
        await readExpandedMuiGridLabelValue(row, page, ["Reason/Remark Code", "Reason/Remark Codes"])
      )
      : "";
    const tableReasonRemarkCode = normalizeRemarkCode(
      cellByAnyExactHeader(cells, headers, ["hipaa codes", "reason/remark codes", "reason/remark"], 6)
    );
    const line = {
      serviceDates: cellByAnyExactHeader(cells, headers, ["service dates"], 1) || cells[0] || "",
      revenueCode: cellByAnyExactHeader(cells, headers, ["revenue code", "rev"], 5) || "",
      procedureCode: procedureCode.trim(),
      dxCodes: cellByAnyExactHeader(cells, headers, ["dx codes"]),
      modifier: cellByAnyExactHeader(cells, headers, ["modifier"], 7),
      quantity: cellByAnyExactHeader(cells, headers, ["quantity", "qty"], 8),
      reasonRemarkCode: (expandedReasonRemarkCode || tableReasonRemarkCode).trim(),
      billed: cellByAnyExactHeader(cells, headers, ["billed", "billed amount"], 4),
      allowed: cellByAnyExactHeader(cells, headers, ["allowed", "allowed amount"]),
      coinsurance: cellByAnyExactHeader(cells, headers, ["coinsurance", "coinsurance amount"]),
      copay: cellByAnyExactHeader(cells, headers, ["copay", "copay amount"]),
      deductible: cellByAnyExactHeader(cells, headers, ["deductible", "deductible amount"]),
      paid: cellByAnyExactHeader(cells, headers, ["paid", "paid amount"], 3)
    };
    logger.info(
      `HIPAA CPT line parsed: procedure="${line.procedureCode}", billed="${line.billed}", paid="${line.paid}", coinsurance="${line.coinsurance}", copay="${line.copay}", deductible="${line.deductible}", remark="${line.reasonRemarkCode}"`
    );
    lines.push(line);
  }

  logger.info(`Extracted ${lines.length} HIPAA CPT line(s) from claim detail page`);
  return lines;
}

async function extractHipaaPaid(page, status, options = {}) {
  logger.info("Extracting HIPAA PAID claim detail");
  const lines = await extractHipaaLineRows(page, options);
  for (const line of lines) {
    line.remarkCode = line.remarkCode || line.reasonRemarkCode || "";
    line.description = line.description || (line.remarkCode ? await getHipaaRemarkDescription(page, line.remarkCode) : "");
  }

  return {
    type: "paid",
    claimNumber: await getInfoPanelValue(page, "Claim Number"),
    claimStatus: status,
    checkNumber: await getInfoPanelValue(page, "Check Number"),
    checkDate: await getInfoPanelValue(page, "Check Date"),
    checkAmount: await getInfoPanelValue(page, "Check Amount"),
    lines
  };
}

async function extractHipaaDenied(page, status, options = {}) {
  logger.info("Extracting HIPAA DENIED claim detail");
  const baseLines = await extractHipaaLineRows(page, options);
  if (baseLines.length === 0) {
    logger.warn("HIPAA DENIED extraction found 0 CPT line rows on detail page.");
  }
  const lines = [];

  for (const item of baseLines) {
    const remarkCode = item.reasonRemarkCode || "";
    lines.push({
      procedureCode: item.procedureCode,
      remarkCode: remarkCode.trim(),
      description: remarkCode.trim() ? await getHipaaRemarkDescription(page, remarkCode.trim()) : ""
    });
  }

  return {
    type: "denied",
    claimNumber: await getInfoPanelValue(page, "Claim Number"),
    claimStatus: status,
    lines
  };
}

async function extractHipaaInProcess(page, status) {
  return {
    type: "in_process",
    claimNumber: await getInfoPanelValue(page, "Claim Number"),
    claimStatus: status,
    receivedDate: await getInfoPanelValue(page, "Received Date")
  };
}

async function returnToResults(page) {
  const frame = await getClaimStatusFrame(page);
  const returnLink = frame.locator(SELECTORS.returnToResults).first();
  if (await returnLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await returnLink.click();
  } else {
    await frame.evaluate(() => window.history.back()).catch(async () => {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    });
  }
  await humanDelay(1000, 1800);
}

module.exports = {
  extractDenied,
  extractHipaaDenied,
  extractHipaaInProcess,
  extractHipaaPaid,
  extractInProcess,
  extractPaid,
  returnToResults,
  waitForClaimDetailPage
};
