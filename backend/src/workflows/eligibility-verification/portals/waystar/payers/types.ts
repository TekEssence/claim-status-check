import type {
  EligibilityInputRow,
  EligibilityResult,
} from "../../../types";

export interface WaystarPayerHandler {
  id: string;
  name: string;
  portalPayerName: string;
  insuranceNameAliases: string[];
  credentialProject?: string;
  requiredFields: string[];
  parseResult(payload: unknown, row: EligibilityInputRow): EligibilityResult;
}
