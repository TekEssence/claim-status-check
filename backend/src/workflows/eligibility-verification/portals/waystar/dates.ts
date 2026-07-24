export function normalizeWaystarDate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const iso = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return formatValidatedDate(Number(iso[2]), Number(iso[3]), Number(iso[1]), value);

  const match = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (!match) throw new Error(`Invalid date of birth "${value}". Use MM/DD/YYYY or DD/MM/YYYY.`);

  const first = Number(match[1]);
  const second = Number(match[2]);
  const shortYear = Number(match[3]);
  const year = match[3].length === 2
    ? shortYear >= 30 ? 1900 + shortYear : 2000 + shortYear
    : shortYear;

  // If the first component cannot be a month, the workbook date is DD/MM/YYYY.
  // Otherwise preserve the portal's normal MM/DD/YYYY interpretation.
  const month = first > 12 ? second : first;
  const day = first > 12 ? first : second;
  return formatValidatedDate(month, day, year, value);
}

function formatValidatedDate(month: number, day: number, year: number, original: string): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 || month > 12 || day < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date of birth "${original}".`);
  }
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}