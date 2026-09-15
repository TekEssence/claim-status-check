import type { AutomationContext } from "../../../../types";
import { installBrowserContextEvalHelpers } from "@/backend/src/core/playwright-browser-eval-helpers";
import type { EligibilityResult, EligibilityRunInput } from "../../../types";
import { buildWaystarOutputWorkbook } from "../../waystar/output";
import { authenticateMedRevenueAvaility } from "./authentication";
import { launchAvailityEligibilityBrowser } from "../browser";
import { readAvailityEligibilityCredentialProfiles } from "../credentials";
import type { AvailityProjectConfig } from "../config/projects";
import { normalize, readMemberSearchRows } from "./data";
import { verifyMemberSearchRow } from "./portal";

export async function runAvailityMemberSearch(input: EligibilityRunInput, context: AutomationContext, config: AvailityProjectConfig) {
  if (input.projectId !== "medrevenue" || config.id !== input.projectId) throw new Error("Availity project configuration mismatch.");
  const inputRows = await readMemberSearchRows(input.inputFile, config);
  if (!inputRows.length) throw new Error("No rows match the MedRevenue Availity payer configuration. Check Primary Insurance Name.");
  const profiles = await readAvailityEligibilityCredentialProfiles(input.credentialFile, input.projectId);
  const rows = new Map(inputRows.map(row => [row.originalIndex, row]));
  const results = new Map<number, EligibilityResult>();
  const errors = new Map<number, string>();
  let session: Awaited<ReturnType<typeof launchAvailityEligibilityBrowser>> | undefined;
  let identity = "";
  let completed = 0;
  await context.emit({ type: "progress", completed, total: rows.size });
  try {
    for (const row of inputRows) {
      if (context.isCancelled?.()) break;
      try {
        const payer = config.payers![row.payerId];
        const aliases = [row.payerId, payer.portalPayerName, ...payer.insuranceNameAliases].map(normalize);
        const exact = profiles.filter(profile => profile.payer && aliases.includes(normalize(profile.payer)));
        const shared = profiles.filter(profile => !profile.payer);
        const candidates = exact.length ? exact : shared;
        if (candidates.length !== 1) throw new Error(`Expected one MedRevenue Availity credential for ${row.payerId}, or one shared credential row.`);
        const credentials = candidates[0];
        const nextIdentity = `${credentials.loginUrl}\u0000${credentials.username}\u0000${credentials.password}\u0000${credentials.totpSecret}`;
        if (!session || identity !== nextIdentity) {
          await session?.browser.close().catch(() => {});
          session = undefined;
          identity = "";
          session = await launchAvailityEligibilityBrowser(message => context.log({ level: "info", message, eventName: "eligibility_availity_browser" }));
          await installBrowserContextEvalHelpers(session.context);
          const page = session.context.pages()[0] ?? await session.context.newPage();
          page.setDefaultTimeout(30_000);
          await authenticateMedRevenueAvaility(page, credentials, context);
          identity = nextIdentity;
        }
        const page = session.context.pages().find(page => !page.isClosed()) ?? await session.context.newPage();
        const result = await verifyMemberSearchRow(page, row, config, message => context.log({ level: 'info', rowIndex: row.originalIndex, message, eventName: 'eligibility_availity_step' }));
        results.set(row.originalIndex, result);
        const missing = result.metadata?.missingFields as string[];
        if (missing.length) await context.log({ level: "warn", rowIndex: row.originalIndex, message: `Availity response is missing: ${missing.join(", ")}.`, eventName: "eligibility_availity_missing_fields" });
        const invalidDates = result.metadata?.invalidDateFields as string[];
        if (invalidDates?.length) await context.log({ level: "warn", rowIndex: row.originalIndex, message: `Availity response dates could not be parsed: ${invalidDates.join(", ")}. Other extracted values were retained.`, eventName: "eligibility_availity_invalid_dates" });
      } catch (error) {
        errors.set(row.originalIndex, error instanceof Error ? error.message : "Availity row processing failed.");
        await context.log({ level: "error", rowIndex: row.originalIndex, message: errors.get(row.originalIndex)!, eventName: "eligibility_availity_row_failed" });
        const failedPage = session?.context.pages().find(page => !page.isClosed());
        const screenshot = await failedPage?.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null);
        if (screenshot) await context.emit({ type: 'error_screenshot', index: row.originalIndex, filename: `availity-row-${row.originalIndex}.jpg`, image: screenshot.toString('base64'), mimeType: 'image/jpeg' });
        await context.log({ level: 'warn', rowIndex: row.originalIndex, message: 'Closing the failed Availity session to prevent reuse of stale patient information.', eventName: 'eligibility_availity_session_cleanup' });
        // A fresh login after a failure avoids submitting stale member results.
        await session?.browser.close().catch(() => {});
        session = undefined;
        identity = "";
      }
      const result = results.get(row.originalIndex);
      await context.emit({ type: "eligibility_availity_result", rowIndex: row.originalIndex, update: {
        __rowKey: String(row.originalIndex), "Coverage Status": errors.has(row.originalIndex) ? "error" : result?.coverageStatus || "unknown",
        "Eff Date": result?.effectiveDate || "-", "End Date": result?.terminationDate || "-",
        "Relationship to Subscriber": result?.relationshipToSubscriber || "-", "Plan Date": result?.planDate || "-",
        "Bot Insurance Type": result?.insuranceType || "-", "Plan Type": result?.planType || "-",
      } });
      await context.emit({ type: "progress", completed: ++completed, total: rows.size });
    }
  } finally {
    await session?.browser.close().catch(() => {});
    for (const row of inputRows) if (!results.has(row.originalIndex) && !errors.has(row.originalIndex)) errors.set(row.originalIndex, "Cancelled - not processed");
    const output = await buildWaystarOutputWorkbook({ inputFile: input.inputFile, rows, results, errors, projectId: input.projectId });
    await context.emit({ type: "file_download", filename: "medrevenue-availity-eligibility-output.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: output.toString("base64") });
  }
}
