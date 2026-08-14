export type AetnaResultOverrides = {
  effectiveDate?: string;
  endDate?: string;
  coinsurance?: string;
  copay?: string;
};

function parseSpecialVisit(text: string): Pick<AetnaResultOverrides, "coinsurance" | "copay"> {
  for (const label of text.matchAll(/\bspecialist\b(?:\s+visit(?:\s+or\s+evaluation)?)?/gi)) {
    const start = (label.index || 0) + label[0].length;
    const afterLabel = text.slice(start, start + 800);
    const boundary = /Coverage\s*Level\s*:|Place\s+of\s+Service\s*:|\b(?:Specialist|Primary\s+Care|Office\s+Visit)\b/i.exec(afterLabel);
    const row = boundary?.index === undefined ? afterLabel : afterLabel.slice(0, boundary.index);
    const coinsurance = row.match(/(?:^|[^\d])((?:100(?:\.0+)?|(?:\d|[1-9]\d)(?:\.\d+)?))\s*%/i)?.[1];
    const copay = row.match(/(\$[\d,]+(?:\.\d{1,2})?)/i)?.[1];
    if (coinsurance || copay) return { coinsurance: coinsurance ? `${coinsurance}%` : "-", copay: copay || "" };
  }
  return {};
}

export function parseAetnaResultOverrides(text: string): AetnaResultOverrides {
  const date = "([A-Za-z]{3,9}\\s+\\d{1,2},\\s*\\d{4})";
  const effectiveDate = text.match(new RegExp(`Eligibility\\s*Begin\\s*Date\\s*:?\\s*${date}`, "i"))?.[1];
  return { effectiveDate, ...parseSpecialVisit(text) };
}
