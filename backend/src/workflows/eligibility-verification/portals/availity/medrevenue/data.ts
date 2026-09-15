import * as XLSX from "xlsx";
import type { EligibilityInputRow, EligibilityResult } from "../../../types";
import { credentialProjectMatches } from "../../../projects";
import { splitPatientName } from "../../waystar/input";
import { normalizeWaystarDate } from "../../waystar/dates";
import type { AvailityProjectConfig } from "../config/projects";

export const normalize = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
export type AvailityMemberRow = EligibilityInputRow & { payerId: string; portalPayerName: string };
function value(raw: Record<string, unknown>, aliases: string[]): string {
  for (const alias of aliases) {
    const key = Object.keys(raw).find(key => normalize(key) === normalize(alias));
    if (key && String(raw[key] ?? "").trim()) return String(raw[key]).trim();
  }
  return "";
}

export async function readMemberSearchRows(file: File, config: AvailityProjectConfig): Promise<AvailityMemberRow[]> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The eligibility workbook has no worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: false, defval: "", blankrows: true });
  if (!rows.length || !Object.keys(rows[0]).some(key => normalize(key) === "primaryinsurancename")) {
    throw new Error('MedRevenue Availity requires "Primary Insurance Name".');
  }
  return rows.flatMap((raw, index) => {
    const project = value(raw, ["Project", "Project Name", "Project ID"]);
    if (project && !credentialProjectMatches(config.id, project)) return [];
    const insurance = value(raw, ["Primary Insurance Name"]);
    const match = Object.entries(config.payers ?? {}).find(([, payer]) =>
      [payer.portalPayerName, ...payer.insuranceNameAliases].some(alias => normalize(alias) === normalize(insurance)));
    if (!match) return [];
    const [payerId, payer] = match;
    const name = splitPatientName(value(raw, ["Patient Name", "Member Name", "Subscriber Name"]));
    return [{ originalIndex: index + 2, raw, payerId, portalPayerName: payer.portalPayerName,
      memberId: value(raw, ["Member ID"]),
      dateOfBirth: value(raw, ["DOB", "Date of Birth", "Patient DOB", "Subscriber Birth Date"]),
      dateOfService: value(raw, ["DOS", "Date of Service", "Date of Service (DOS)"]),
      patientFirstName: value(raw, ["Patient First Name", "First Name"]) || name.firstName,
      patientLastName: value(raw, ["Patient Last Name", "Last Name"]) || name.lastName,
    }];
  });
}

export function normalizeResponseDate(value: string): string {
  if (!value.trim()) return "";
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const named = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})$/);
  if (named) {
    const month = monthNames.indexOf(named[1].slice(0, 3).toLowerCase()) + 1;
    return normalizeWaystarDate(`${month}/${named[2]}/${named[3]}`);
  }
  return normalizeWaystarDate(value);
}

export function parseMemberSearchResult(fields: Record<string, string>, row: AvailityMemberRow): EligibilityResult {
  const status = fields.status?.trim() || "";
  if (!status) throw new Error("Eligibility result unavailable: coverage status is missing.");
  const coverageStatus = /inactive|terminated|not active|no coverage/i.test(status) ? "inactive"
    : /\bactive\b/i.test(status) ? "active" : "unknown";
  const dates = (fields.effectiveDate || "").trim().split(/\s+(?:-|–|—|to)\s+|(?<=[0-9])\s*[-–—]\s*(?=[A-Za-z]|\d{1,2}\/)/i);
  const invalidDateFields: string[] = [];
  const date = (value: string, key: string) => {
    if (/^(?:\s*|\s*[-–—]\s*|\s*n\/?a\s*)$/i.test(value)) return "";
    try { return normalizeResponseDate(value); }
    catch { invalidDateFields.push(key); return ""; }
  };
  const effectiveDate = date(dates[0] || "", "effectiveDate");
  const terminationDate = date(dates[1] || "", "terminationDate");
  const planDate = date(fields.planDate || "", "planDate");
  return { rowIndex: row.originalIndex, payerId: row.payerId, coverageStatus, planStatus: status,
    effectiveDate, terminationDate,
    relationshipToSubscriber: fields.relationship || "-", planDate,
    insuranceType: fields.insuranceType, planType: fields.planType, benefits: [],
    metadata: { displayedCoverageStatus: status, displayedFields: { ...fields }, invalidDateFields,
      missingFields: ["effectiveDate", "relationship", "planDate", "insuranceType", "planType"].filter(key => !({ ...fields, effectiveDate, planDate })[key]) },
  };
}

/** A unique positive identity match is required; never pick the first result. */
export function matchingMemberIndex(cells: string[][], row: AvailityMemberRow): number {
  const wantedId = normalize(row.memberId);
  const dob = normalizeWaystarDate(row.dateOfBirth || "");
  const matches = cells.flatMap((values, index) => {
    const idMatch = wantedId && values.some(text => text.split(/\s+/).some(token => normalize(token) === wantedId));
    const first = normalize(row.patientFirstName), last = normalize(row.patientLastName);
    const nameMatch = first && last && values.some(text => {
      const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return tokens.includes(first) && tokens.includes(last);
    });
    const visibleDates = values.flatMap(text => text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) || []);
    const dobMatch = visibleDates.some(date => normalizeWaystarDate(date) === dob);
    if (visibleDates.length && !dobMatch) return [];
    return idMatch || (nameMatch && dobMatch) ? [index] : [];
  });
  if (matches.length !== 1) throw new Error(matches.length ? "Multiple matching members returned; selection is ambiguous." : "No member result matches the input member identity.");
  return matches[0];
}
