import * as XLSX from "xlsx";

export const CLAIM_CREDENTIAL_SCOPE_COLUMNS = {
  group: "__infer_group_from_claims",
  payer: "__infer_payer_from_claims",
} as const;

type Scope = { group?: string; payer?: string; validationStatus?: string; validation_status?: string };

/**
 * Resolve an explicit workbook instruction to inherit an omitted account scope.
 * JSON ingestion encodes that instruction instead of parsing portal claims in
 * the API. Both upload and service workbooks use this same worker preparation.
 * Ordinary login workbooks have no instruction, so their validation is unchanged.
 * Explicit scopes always win; ambiguous scopes never choose an arbitrary account.
 */
export function resolveClaimCredentialScopes(buffer: ArrayBuffer, readScopes: () => Scope[]): ArrayBuffer {
  const book = XLSX.read(buffer, { type: "array" });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) return buffer;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
  const enabled = (value: unknown) => value === true || value === "true";
  if (!rows.some(row => Object.values(CLAIM_CREDENTIAL_SCOPE_COLUMNS).some(column => enabled(row[column])))) return buffer;
  const scopes = readScopes();
  // Rows that native validation excludes from credential routing must not make
  // an otherwise usable account default ambiguous. For an all-invalid batch,
  // retain any unique supplied scope so its existing row failures can be written.
  const validScopes = scopes.filter(scope => (scope.validationStatus ?? scope.validation_status) === "valid");
  const candidates = validScopes.length ? validScopes : scopes;
  for (const row of rows) {
    for (const key of ["group", "payer"] as const) {
      const column = key === "group" ? "Group" : "Responsible Payer";
      if (!enabled(row[CLAIM_CREDENTIAL_SCOPE_COLUMNS[key]]) || String(row[column] ?? "").trim()) continue;
      const values = [...new Set(candidates.map(scope => scope[key]?.trim() ?? "").filter(Boolean))];
      if (values.length > 1) throw new Error(`Credential ${column} cannot be inferred uniquely from claims. Provide an explicit credential scope.`);
      if (values.length === 1) row[column] = values[0];
    }
  }
  book.Sheets[book.SheetNames[0]] = XLSX.utils.json_to_sheet(rows);
  const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
