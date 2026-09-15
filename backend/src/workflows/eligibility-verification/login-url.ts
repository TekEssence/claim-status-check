/** Follow the workbook destination, as the UHC and Availity runners do. */
export function normalizeEligibilityLoginUrl(value: string): string {
  const raw = value.trim();
  const normalized = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('The login workbook must contain a valid portal URL.');
  }
  if (!raw || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('The login workbook URL must use HTTP or HTTPS.');
  }
  return normalized;
}
