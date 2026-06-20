import * as XLSX from "xlsx";
import { asText } from "./claims/dates";

export type IehpGenericRow = Record<string, unknown>;

export type IehpProcessClaimsInput = {
  loginUrl: string;
  claimStatusUrl: string;
  claimStatusUrlWasProvided: boolean;
  userName: string;
  password: string;
  claimRows: IehpGenericRow[];
  startIndex: number;
};

export async function parseIehpProcessClaimsInput(formData: FormData): Promise<IehpProcessClaimsInput> {
  const loginExcelFile = formData.get("loginExcel") as File | null;
  const claimRowsJson = formData.get("claimRows") as string | null;
  const startIndex = parseInt(formData.get("startIndex") as string || "0", 10);

  if (!loginExcelFile || !(loginExcelFile instanceof File) || !claimRowsJson) {
    throw new Error("Missing login Excel file or claim rows.");
  }

  const loginArrayBuffer = await loginExcelFile.arrayBuffer();
  const loginWorkbook = XLSX.read(loginArrayBuffer, { type: "array" });
  const loginSheetName = loginWorkbook.SheetNames[0];
  const loginSheet = loginWorkbook.Sheets[loginSheetName];
  const loginRows = XLSX.utils.sheet_to_json(loginSheet) as IehpGenericRow[];

  if (loginRows.length === 0) {
    throw new Error("Login Excel file is empty.");
  }

  const firstLoginRow = loginRows[0];
  const rawUrl = asText(firstLoginRow["URL"] ?? firstLoginRow["url"]);
  const userName = asText(firstLoginRow["User Name"] ?? firstLoginRow["user name"] ?? firstLoginRow["username"]);
  const password = asText(firstLoginRow["Password"] ?? firstLoginRow["password"]);

  if (!rawUrl || !userName || !password) {
    throw new Error("Invalid login credentials format.");
  }

  const claimStatusUrl = asText(firstLoginRow["Claim Status URL"] ?? firstLoginRow["claim status url"] ?? firstLoginRow["claimUrl"]);

  return {
    loginUrl: rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`,
    claimStatusUrl: claimStatusUrl || "https://providers.iehp.org/claims/status",
    claimStatusUrlWasProvided: Boolean(claimStatusUrl),
    userName,
    password,
    claimRows: JSON.parse(claimRowsJson) as IehpGenericRow[],
    startIndex,
  };
}
