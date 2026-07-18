import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import type { ScraperContext } from "../../types";
import { readLoginExcel } from "./excel";
import { runAutomation, type ProviderSelection, type SseEvent } from "./automation";

function getRequiredFile(formData: FormData, key: string): File {
  const value = formData.get(key);
  if (!(value instanceof File)) {
    throw new Error(`Missing ${key} file.`);
  }
  return value;
}

function getRequiredString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value.trim();
}

function getOptionalString(formData: FormData, key: string, fallback = ""): string {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseProviderSelection(value: string, stage: "corporate" | "care"): ProviderSelection {
  try {
    const parsed = JSON.parse(value) as ProviderSelection;
    return {
      corporateTaxIdOwner: typeof parsed.corporateTaxIdOwner === "string" ? parsed.corporateTaxIdOwner : "",
      careProvider: typeof parsed.careProvider === "string" ? parsed.careProvider : "",
    };
  } catch {
    return stage === "corporate" ? { corporateTaxIdOwner: value } : { careProvider: value };
  }
}

export async function runUhcClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const loginExcel = getRequiredFile(formData, "loginExcel");
  const claimRowsJson = getRequiredString(formData, "claimRows");
  const claims = JSON.parse(claimRowsJson);
  if (!Array.isArray(claims)) {
    throw new Error("claimRows must be a JSON array.");
  }

  const credentials = await readLoginExcel(await loginExcel.arrayBuffer());
  const startIndex = Number(getOptionalString(formData, "startIndex", "0"));
  const attempt = Number(getOptionalString(formData, "attempt", "1"));
  const browserType = getOptionalString(formData, "browserType", "chrome");
  const clientType = getOptionalString(formData, "clientType", "minimax");

  const sendEvent = async (event: SseEvent) => {
    await context.emit(event as unknown as Record<string, unknown>);
  };

  await context.log({
    level: "info",
    message: `UHC input loaded: ${claims.length} row(s). Group: ${clientType}.`,
  });

  await runAutomation({
    username: credentials.username,
    password: credentials.password,
    baseUrl: credentials.url,
    claims,
    startIndex: Number.isFinite(startIndex) && startIndex >= 0 ? startIndex : 0,
    browserType,
    clientType,
    requestOtp: async () => {
      const inputName = `uhc_otp_${crypto.randomUUID()}`;
      await context.emit({
        type: "otp_request",
        inputName,
        label: clientType === "medrevenu" ? "MedRevenu OTP" : "UHC OTP",
        message: "Enter the verification code to continue UHC login.",
      });
      return waitForScrapeJobInput(context.jobId, inputName, 10 * 60 * 1000);
    },
    requestProviderSelection: async (options, stage) => {
      const inputName = `uhc_provider_${stage}_${crypto.randomUUID()}`;
      await context.emit({
        type: "provider_options",
        inputName,
        providerStage: stage,
        corporateTaxIdOwners: options.corporateTaxIdOwners,
        careProviders: options.careProviders,
        label: stage === "corporate" ? "Corporate Tax ID Owner" : "Care Provider",
        message: stage === "corporate"
          ? "Choose the corporate owner so UHC can load the correct care providers."
          : "Choose the care provider for this UHC run.",
      });
      const selectedValue = await waitForScrapeJobInput(context.jobId, inputName, 10 * 60 * 1000);
      return parseProviderSelection(selectedValue, stage);
    },
    attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
    batchSize: Math.max(claims.length, 50),
    sendEvent,
  });
}
