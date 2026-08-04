import type { AutomationRunner } from "../../../types";
import type { EligibilityRunInput } from "../../types";
import { authenticateAvailityEligibility } from "./authentication";
import { launchAvailityEligibilityBrowser } from "./browser";
import { readAvailityEligibilityCredentials } from "./credentials";
import { readAvailityEligibilityInputPayer } from "./input-routing";
import { getAvailityEligibilityPayer } from "./payers/registry";

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) throw new Error(`${label} is required.`);
  return value;
}

export function createAvailityEligibilityRunner(): AutomationRunner<EligibilityRunInput> {
  return {
    workflowId: "eligibility-verification",
    portalId: "availity",
    name: "Availity Eligibility Verification",
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("Availity eligibility input must be multipart form data.");
      return {
        inputFile: requireFile(input, "inputFile", "Eligibility input file"),
        credentialFile: requireFile(input, "credentialFile", "Availity login file"),
      };
    },
    async run(input, context) {
      const payerId = await readAvailityEligibilityInputPayer(input.inputFile);
      const payer = getAvailityEligibilityPayer(payerId);
      const credentials = await readAvailityEligibilityCredentials(input.credentialFile);
      const log = async (message: string) => context.log({
        level: "info",
        message,
        eventName: "eligibility_availity_authentication",
      });
      const session = await launchAvailityEligibilityBrowser(log);
      const page = session.context.pages()[0] ?? await session.context.newPage();
      page.setDefaultTimeout(Number(process.env.PORTAL_AVAILITY_ELIGIBILITY_DEFAULT_TIMEOUT_MS || 30_000));
      page.setDefaultNavigationTimeout(Number(process.env.PORTAL_AVAILITY_ELIGIBILITY_NAVIGATION_TIMEOUT_MS || 45_000));
      let stage = "browser initialization";
      try {
        stage = "Availity login and authenticator OTP";
        await log("Opening Availity login page for eligibility verification.");
        await authenticateAvailityEligibility(page, credentials);
        await context.log({
          level: "info",
          message: "Availity eligibility login and MFA authentication completed.",
          eventName: "eligibility_availity_login_complete",
        });
        stage = `Patient Registration > Eligibility and Benefits Inquiry > ${payer.name} processing`;
        await payer.run({ page, inputFile: input.inputFile, context });
        stage = "completed";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack || "Stack trace unavailable." : "Stack trace unavailable.";
        const title = await page.title().catch(() => "Unavailable");
        const report = [
          "Availity eligibility error report",
          `Generated: ${new Date().toISOString()}`,
          `Job ID: ${context.jobId}`,
          `Workflow: Eligibility Verification`,
          `Portal: Availity`,
          `Payer: ${payer.name}`,
          `Failed stage: ${stage}`,
          `Page URL: ${page.url() || "Unavailable"}`,
          `Page title: ${title || "Unavailable"}`,
          "",
          `Error: ${message}`,
          "",
          "Stack trace:",
          stack,
          "",
          "Navigation expected:",
          "1. Click Patient Registration in the top navigation.",
          "2. Click Eligibility and Benefits Inquiry in its dropdown.",
          "3. Wait for the payer field.",
          "4. Wait for the payer field.",
        ].join("\n");
        await context.emit({
          type: "file_download",
          filename: "availity-eligibility-error-report.txt",
          mimeType: "text/plain",
          base64: Buffer.from(report, "utf8").toString("base64"),
        }).catch(() => {});
        const screenshot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
        if (screenshot) {
          await context.emit({
            type: "error_screenshot",
            index: -1,
            filename: "availity-eligibility-error-screenshot.jpg",
            image: screenshot.toString("base64"),
          }).catch(() => {});
        }
        await context.log({
          level: "error",
          message: `Availity eligibility failed during ${stage}: ${message}`,
          eventName: "eligibility_availity_failed",
          meta: { stage, url: page.url() },
        }).catch(() => {});
        throw error;
      } finally {
        await session.browser.close().catch(() => {});
      }
    },
  };
}
