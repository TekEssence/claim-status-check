import type { Page } from "playwright-core";
import type { AutomationContext } from "../../../../types";

export type AvailityEligibilityPayerWorkflowInput = {
  page: Page;
  inputFile: File;
  context: AutomationContext;
};

export interface AvailityEligibilityPayerHandler {
  id: string;
  name: string;
  run(input: AvailityEligibilityPayerWorkflowInput): Promise<void>;
}
