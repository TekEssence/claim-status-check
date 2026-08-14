import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import type { Page } from "playwright-core";
import { launchAvailityBrowser } from "../../portals/availity/browser";
import { AvailityClaimSearchService } from "./claim-search-service";
import type { AvailityNormalizedSummaryRow } from "./types";

const require = createRequire(import.meta.url);
const { submitLogin } = require("../../portals/availity/legacy/pages/login.page.js");
const { handleMfa } = require("../../portals/availity/legacy/pages/mfa.page.js");
const { acceptCookiesIfPresent, logoutIfPresent, openClaimStatus } = require("../../portals/availity/legacy/pages/navigation.page.js");
const { selectPayer } = require("../../portals/availity/legacy/pages/claim-status-member.page.js");

type WorkbookRows = {
  headers: string[];
  rows: Record<string, string>[];
};

type TestCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  totpSecret: string;
};

type NetworkTestInputRow = {
  inputRowId: number;
  portalPayerName: string;
  payerId: string;
  fromDate: string;
  toDate: string;
  providerNpi: string;
  submitterId: string;
  requestedStatus: string;
  claimNumber: string;
  billedAmount: string;
  memberId: string;
  patientName: string;
  accountNumber: string;
  customerId: string;
  clientId: string;
};

type NetworkTestOutputRow = Record<string, string | number>;

type ProviderDirectoryResponse = {
  providers?: Array<{
    npi?: string;
    taxId?: string;
    uiDisplayName?: string;
    customerIds?: string[];
  }>;
};

function asText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return `${String(value.getMonth() + 1).padStart(2, "0")}/${String(value.getDate()).padStart(2, "0")}/${value.getFullYear()}`;
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value).trim();
}

function normalizeHeader(value: unknown): string {
  return asText(value).replace(/\s+/g, " ").trim();
}

function normalizeAlias(value: unknown): string {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeMoney(value: unknown): string {
  const numeric = Number(asText(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "";
}

function normalizeId(value: unknown): string {
  return asText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function normalizeName(value: unknown): string {
  return asText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function findValue(row: Record<string, string>, aliases: string[]): string {
  const wanted = new Set(aliases.map(normalizeAlias));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeAlias(key)) && value) {
      return value.trim();
    }
  }
  return "";
}

function normalizeLoginUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

function toIsoDate(value: string): string {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid DOS "${raw}". Expected MM/DD/YYYY or YYYY-MM-DD.`);
  }

  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

async function readWorkbookRows(filePath: string): Promise<WorkbookRows> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(`Workbook has no sheets: ${filePath}`);
  }

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cell.value);
  });

  const rows: Record<string, string>[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const data: Record<string, string> = {};
    headers.forEach((header, colNumber) => {
      if (header) {
        data[header] = asText(row.getCell(colNumber).value);
      }
    });
    if (Object.values(data).some(Boolean)) {
      rows.push(data);
    }
  });

  return {
    headers: headers.filter(Boolean),
    rows,
  };
}

function parseCredentials(rows: Record<string, string>[]): TestCredentials {
  for (const row of rows) {
    const loginUrl = findValue(row, ["Link", "URL", "Login URL", "Portal Link", "LOGIN_URL_AVA"]);
    const username = findValue(row, ["Username", "User Name", "User ID", "USERNAME_AVA1"]);
    const password = findValue(row, ["Password", "PASSWORD_AVA1"]);
    const totpSecret = findValue(row, ["Secret Key", "Secret", "TOTP Secret", "TOTP_SECRET"]);

    if (loginUrl && username && password && totpSecret) {
      return {
        loginUrl: normalizeLoginUrl(loginUrl),
        username,
        password,
        totpSecret,
      };
    }
  }

  throw new Error("Login Excel must contain Link, Username, Password, and Secret Key.");
}

function parseNetworkRows(rows: Record<string, string>[]): NetworkTestInputRow[] {
  return rows.map((row, index) => {
    const payerId = findValue(row, ["Payer ID", "PayerId"]);
    const portalPayerName = findValue(row, ["Portal Payer Name", "Payer Name", "Payer"]);
    const dos = findValue(row, ["DOS", "Service Date", "From Date"]);
    const providerNpi = findValue(row, ["Provider NPI", "ProviderNpi"]);
    const submitterId = findValue(row, ["Submitter ID", "SubmitterId"]);
    const requestedStatus = findValue(row, ["Requested Status", "RequestedStatus"]) || "ALL";
    const claimNumber = findValue(row, ["Claim Number", "Claim No", "Claim"]);
    const billedAmount = findValue(row, ["Billed Amount", "Charges", "Claim Level Billed Amount"]);
    const memberId = findValue(row, ["Member ID", "Subscriber No", "Subscriber ID"]);
    const patientName = findValue(row, ["Patient Name", "Member Name"]);
    const accountNumber = findValue(row, ["Account Number", "Account No", "Patient Account Number"]);
    const customerId = findValue(row, ["Customer ID", "CustomerId", "Availity Customer ID"]);
    const clientId = findValue(row, ["Client ID", "ClientId", "Availity Client ID"]);

    const missing = [
      ["Payer ID", payerId],
      ["DOS", dos],
      ["Provider NPI", providerNpi],
      ["Submitter ID", submitterId],
    ].filter(([, value]) => !value).map(([label]) => label);

    if (missing.length) {
      throw new Error(`Network test row ${index + 1} is missing: ${missing.join(", ")}.`);
    }

    const fromDate = toIsoDate(dos);
    return {
      inputRowId: index + 1,
      portalPayerName: portalPayerName || payerId,
      payerId,
      fromDate,
      toDate: fromDate,
      providerNpi,
      submitterId,
      requestedStatus,
      claimNumber,
      billedAmount,
      memberId,
      patientName,
      accountNumber,
      customerId,
      clientId,
    };
  });
}

function selectSummaryRows(rows: AvailityNormalizedSummaryRow[], inputRow: NetworkTestInputRow): AvailityNormalizedSummaryRow[] {
  if (inputRow.claimNumber) {
    return rows.filter((row) => row.claimNumber.toUpperCase() === inputRow.claimNumber.toUpperCase());
  }

  const inputBilledAmount = normalizeMoney(inputRow.billedAmount);
  const inputMemberId = normalizeId(inputRow.memberId);
  const inputPatientName = normalizeName(inputRow.patientName);
  const inputAccountNumber = normalizeId(inputRow.accountNumber);

  const matchedRows = rows.filter((row) => {
    return (!inputBilledAmount || normalizeMoney(row.billedAmount) === inputBilledAmount)
      && (!inputMemberId || normalizeId(row.memberId) === inputMemberId)
      && (!inputPatientName || normalizeName(row.patientName) === inputPatientName)
      && (!inputAccountNumber || normalizeId(row.patientAccountNumber) === inputAccountNumber);
  });

  return matchedRows.length ? matchedRows : rows;
}

function renderCptLines(lines: Awaited<ReturnType<AvailityClaimSearchService["searchDetail"]>>["detail"]["lines"]): string {
  return lines.map((line) => {
    return [
      `CPT ${line.procedureCode || "NA"}`,
      line.status || "NA",
      `billed ${line.billed || "NA"}`,
      `paid ${line.paid || "NA"}`,
      `copay ${line.copay || "NA"}`,
      `coinsurance ${line.coinsurance || "NA"}`,
      `deductible ${line.deductible || "NA"}`,
      line.remarkCode ? `remarks ${line.remarkCode}` : "",
    ].filter(Boolean).join(" | ");
  }).join("\n");
}

function joinOutputValues(values: string[]): string {
  return values.filter(Boolean).join("\n\n");
}

function renderClaimDetailBlock(detail: Awaited<ReturnType<AvailityClaimSearchService["searchDetail"]>>["detail"]): string {
  return [
    `Claim ${detail.claimNumber || "NA"} - ${detail.claimStatus || "NA"}`,
    renderCptLines(detail.lines),
  ].filter(Boolean).join("\n");
}

async function waitForCapturedClientId(page: Page, state: { clientId: string }, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.clientId) return state.clientId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return state.clientId;
}

async function waitForCapturedCustomerId(state: { customerId: string }, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.customerId) return state.customerId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return state.customerId;
}

async function getProviderCustomerId(page: Page, providerNpi: string, fallbackCustomerId = ""): Promise<string> {
  const providerResponse = await page.request.get("https://essentials.availity.com/api/internal/v1/providers", {
    params: {
      offset: "0",
      limit: "50",
      q: "",
      ...(fallbackCustomerId ? { customerId: fallbackCustomerId } : {}),
    },
  });

  if (!providerResponse.ok()) {
    return fallbackCustomerId;
  }

  const payload = await providerResponse.json().catch(() => null) as ProviderDirectoryResponse | null;
  const provider = payload?.providers?.find((candidate) => String(candidate.npi || "").trim() === providerNpi);
  return provider?.customerIds?.[0] || fallbackCustomerId;
}

async function login(page: Page, credentials: TestCredentials): Promise<void> {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await submitLogin(page, credentials.username, credentials.password);
  await handleMfa(page, credentials.totpSecret, 2, 0, 20);
  await acceptCookiesIfPresent(page, 10000);
  await openClaimStatus(page);
}

async function writeOutputWorkbook(outputPath: string, rows: NetworkTestOutputRow[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Network_Test_Output");
  const columns = [
    "input_row_id",
    "network_status",
    "network_notes",
    "summary_count",
    "selected_claim_number",
    "claim_status",
    "service_date",
    "received_date",
    "check_date",
    "check_number",
    "check_amount",
    "paid_amount",
    "billed_amount",
    "cpt_lines",
  ];

  worksheet.addRow(columns);
  for (const row of rows) {
    worksheet.addRow(columns.map((column) => row[column] ?? ""));
  }
  worksheet.getRow(1).font = { bold: true };
  worksheet.columns.forEach((column) => {
    column.width = 26;
    column.alignment = { vertical: "top", wrapText: true };
  });

  await workbook.xlsx.writeFile(outputPath);
}

export async function runAvailityNetworkExcelTest(options: {
  loginExcelPath: string;
  claimExcelPath: string;
  outputPath?: string;
  log?: (message: string) => Promise<void> | void;
}): Promise<string> {
  const log = async (message: string) => {
    await options.log?.(message);
  };
  const outputPath = options.outputPath || path.join(
    path.dirname(options.claimExcelPath),
    `availity_network_test_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}.xlsx`,
  );

  const credentialsWorkbook = await readWorkbookRows(options.loginExcelPath);
  const claimWorkbook = await readWorkbookRows(options.claimExcelPath);
  const credentials = parseCredentials(credentialsWorkbook.rows);
  const inputRows = parseNetworkRows(claimWorkbook.rows);
  const outputRows: NetworkTestOutputRow[] = [];
  const automationState = { selectedPayer: "" };
  const capturedState = { clientId: "", customerId: "" };

  await log(`Loaded ${inputRows.length} Availity network test row(s).`);
  const session = await launchAvailityBrowser(log);
  const page = session.context.pages()[0] ?? await session.context.newPage();
  page.on("request", (request) => {
    const clientId = request.headers()["x-client-id"];
    if (clientId && !capturedState.clientId) {
      capturedState.clientId = clientId;
    }
    try {
      const url = new URL(request.url());
      const customerId = url.searchParams.get("customerId") || "";
      if (customerId && !capturedState.customerId) {
        capturedState.customerId = customerId;
      }
    } catch {}
  });
  page.setDefaultTimeout(Number(process.env.PORTAL_AVAILITY_DEFAULT_TIMEOUT_MS || 30000));
  page.setDefaultNavigationTimeout(Number(process.env.PORTAL_AVAILITY_NAVIGATION_TIMEOUT_MS || 45000));

  try {
    await log("Logging into Availity for network test.");
    await login(page, credentials);

    for (const inputRow of inputRows) {
      await log(`Running Availity network test row ${inputRow.inputRowId}.`);
      try {
        if (inputRow.portalPayerName && automationState.selectedPayer !== inputRow.portalPayerName) {
          await log(`Selecting Availity portal payer "${inputRow.portalPayerName}" before network search.`);
          await selectPayer(page, inputRow.portalPayerName);
          automationState.selectedPayer = inputRow.portalPayerName;
        }

        const clientId = inputRow.clientId || await waitForCapturedClientId(page, capturedState);
        const capturedCustomerId = inputRow.customerId || await waitForCapturedCustomerId(capturedState);
        const customerId = inputRow.customerId || await getProviderCustomerId(page, inputRow.providerNpi, capturedCustomerId);
        await log(`Using network headers: customer_id="${customerId || "blank"}", client_id="${clientId || "blank"}".`);
        const service = new AvailityClaimSearchService({
          context: session.context,
          customerId,
          clientId,
        });

        const summary = await service.searchSummary({
          payerId: inputRow.payerId,
          fromDate: inputRow.fromDate,
          toDate: inputRow.toDate,
          providerNpi: inputRow.providerNpi,
          submitterId: inputRow.submitterId,
          requestedStatus: inputRow.requestedStatus,
        });
        const selectedRows = selectSummaryRows(summary.rows, inputRow);
        if (!selectedRows.length) {
          throw new Error(inputRow.claimNumber
            ? `Claim ${inputRow.claimNumber} was not found in ${summary.rows.length} summary row(s).`
            : `No summary rows returned.`);
        }

        await log(`Selected ${selectedRows.length} summary row(s) for detail extraction.`);
        const details = [];
        for (const selectedRow of selectedRows) {
          details.push(await service.searchDetail({
            parentTransactionId: summary.parentTransactionId,
            payerId: inputRow.payerId,
            requestType: "CLAIM_NUMBER",
            claimNumber: selectedRow.claimNumber,
            claimIndex: selectedRow.claimIndex,
            providerNpi: inputRow.providerNpi,
          }));
        }

        outputRows.push({
          input_row_id: inputRow.inputRowId,
          network_status: "success",
          network_notes: selectedRows.length > 1
            ? `${selectedRows.length} matching summary rows were extracted and combined.`
            : "",
          summary_count: summary.rows.length,
          selected_claim_number: joinOutputValues(details.map((detail) => detail.detail.claimNumber)),
          claim_status: joinOutputValues(details.map((detail) => detail.detail.claimStatus)),
          service_date: joinOutputValues(details.map((detail) => detail.detail.serviceDate)),
          received_date: joinOutputValues(details.map((detail) => detail.detail.receivedDate)),
          check_date: joinOutputValues(details.map((detail) => detail.detail.checkDate)),
          check_number: joinOutputValues(details.map((detail) => detail.detail.checkNumber)),
          check_amount: joinOutputValues(details.map((detail) => detail.detail.checkAmount)),
          paid_amount: joinOutputValues(details.map((detail) => detail.detail.paidAmount)),
          billed_amount: joinOutputValues(details.map((detail) => detail.detail.billedAmount)),
          cpt_lines: joinOutputValues(details.map((detail) => renderClaimDetailBlock(detail.detail))),
        });
      } catch (error) {
        outputRows.push({
          input_row_id: inputRow.inputRowId,
          network_status: "failed",
          network_notes: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await writeOutputWorkbook(outputPath, outputRows);
    await log(`Availity network test output written: ${outputPath}`);
    return outputPath;
  } finally {
    if (!page.isClosed()) {
      await logoutIfPresent(page).catch(() => {});
    }
    await session.browser.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const loginExcelPath = process.env.AVAILITY_NETWORK_LOGIN_EXCEL;
  const claimExcelPath = process.env.AVAILITY_NETWORK_CLAIM_EXCEL;
  const outputPath = process.env.AVAILITY_NETWORK_OUTPUT_EXCEL;

  if (!loginExcelPath || !claimExcelPath) {
    throw new Error("Set AVAILITY_NETWORK_LOGIN_EXCEL and AVAILITY_NETWORK_CLAIM_EXCEL before running this test.");
  }

  const writtenPath = await runAvailityNetworkExcelTest({
    loginExcelPath,
    claimExcelPath,
    outputPath,
    log: (message) => {
      console.log(`[availity-network-test] ${message}`);
    },
  });
  console.log(writtenPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
