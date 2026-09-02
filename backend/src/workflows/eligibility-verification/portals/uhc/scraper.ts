import type { AutomationRunner } from "../../../types";
import type { EligibilityRunInput } from "../../types";
import { authenticateUhcEligibility } from "./authentication";
import { launchUhcEligibilityBrowser } from "./browser";
import { readUhcEligibilityCredentials } from "./credentials";
import { getUhcEligibilityPayer } from "./payers/registry";
import { runUhcWellmedEligibilityWorkflow } from "./payers/uhc-wellmed/workflow";
import { parseEligibilityProjectId, scopeEligibilityInputFile } from "../../projects";

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) throw new Error(`${label} is required.`);
  return value;
}

export function createUhcEligibilityRunner(payerId = "uhc-wellmed"): AutomationRunner<EligibilityRunInput> {
  const payer = getUhcEligibilityPayer(payerId);
  return {
    workflowId: "eligibility-verification",
    portalId: "uhc",
    payerId: payer.id,
    name: `${payer.name} Eligibility Verification`,
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("UHC eligibility input must be multipart form data.");
      const projectId = parseEligibilityProjectId(input.get("projectId"));
      if (projectId !== "minimax") throw new Error("UHC eligibility is currently configured only for Minimax.");
      return {
        inputFile: requireFile(input, "inputFile", "Eligibility input file"),
        credentialFile: requireFile(input, "credentialFile", "UHC login file"),
        projectId,
      };
    },
    async run(input, context) {
      const scopedInputFile = await scopeEligibilityInputFile(input.inputFile, input.projectId);
      const credentials = await readUhcEligibilityCredentials(input.credentialFile, input.projectId);
      await context.log({ level: "info", message: `Eligibility project selected: ${input.projectId === "minimax" ? "Minimax" : "MedRevenue"}.`, eventName: "eligibility_project_selected", meta: { projectId: input.projectId } });
      const log = async (message: string) => context.log({ level: "info", message, eventName: "eligibility_uhc_authentication" });
      const session = await launchUhcEligibilityBrowser(log);
      const page = session.context.pages()[0] ?? await session.context.newPage();
      page.setDefaultTimeout(Number(process.env.PORTAL_UHC_ELIGIBILITY_DEFAULT_TIMEOUT_MS || 30_000));
      page.setDefaultNavigationTimeout(Number(process.env.PORTAL_UHC_ELIGIBILITY_NAVIGATION_TIMEOUT_MS || 45_000));
      try {
        await log(`Opening UHC login page with the ${input.projectId === "minimax" ? "Minimax/TPM" : "MedRevenue"} credential row.`);
        try {
          await authenticateUhcEligibility(page, credentials);
        } catch (error) {
          const screenshot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
          if (screenshot) {
            await context.emit({
              type: "error_screenshot",
              index: 0,
              image: screenshot.toString("base64"),
            });
          }
          throw error;
        }
        await log("UHC login and authenticator OTP verification completed.");
        await runUhcWellmedEligibilityWorkflow({ page, inputFile: scopedInputFile, context });
      } finally {
        await session.browser.close().catch(() => {});
      }
    },
  };
}
