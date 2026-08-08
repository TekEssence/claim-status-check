import type { UhcEligibilityOutput } from "./workflow";

function valueAfterLabel(text: string, labels: string[]): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    for (const label of labels) {
      if (lines[index].toLowerCase() === label.toLowerCase()) {
        for (let valueIndex = index + 1; valueIndex <= Math.min(index + 5, lines.length - 1); valueIndex += 1) {
          const value = lines[valueIndex] ?? "";
          if (/^(?:keyboard_arrow_(?:down|up)|expand_(?:more|less)|arrow_drop_(?:down|up))$/i.test(value)) continue;
          return value;
        }
        return "";
      }
      const inline = lines[index].match(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:-]\\s*(.+)$`, "i"));
      if (inline) return inline[1].trim();
    }
  }
  return "";
}

function section(text: string, start: RegExp, end: RegExp): string {
  const startIndex = text.search(start);
  if (startIndex < 0) return "";
  const rest = text.slice(startIndex);
  const endMatch = rest.slice(1).search(end);
  return endMatch < 0 ? rest : rest.slice(0, endMatch + 1);
}

function money(value: string): string {
  const cleaned = value.replace(/,/g, "").trim();
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return value.trim();
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function metAndTotal(block: string, label: RegExp): { met: string; total: string } | null {
  const labelMatch = block.match(label);
  if (!labelMatch || labelMatch.index == null) return null;
  const tail = block.slice(labelMatch.index + labelMatch[0].length, labelMatch.index + labelMatch[0].length + 240);
  const values = tail.match(/\$\s*[\d,]+(?:\.\d{1,2})?/g) ?? [];
  if (values.length < 2) return null;
  return { met: money(values[0]!.replace("$", "")), total: money(values[1]!.replace("$", "")) };
}

function specialistBenefits(text: string): { copay: string; coinsurance: string } {
  const block = section(text, /\bSpecialist Visit\b/i, /\n\s*(?:[A-Z][A-Za-z ]+ Visit|Status|Detailed Benefits)\b/i);
  if (!block) return { copay: "", coinsurance: "" };
  const copay = block.match(/\$\s*[\d,]+(?:\.\d{1,2})?\s*(?:\/\s*visit)?/i)?.[0]?.replace(/\s+/g, " ") ?? "";
  const coinsurance = block.match(/\b\d+(?:\.\d+)?\s*%/)?.[0]?.replace(/\s+/g, "") ?? "";
  return { copay, coinsurance };
}

export function applyUhcResultLayout(
  text: string,
  initial: UhcEligibilityOutput,
): UhcEligibilityOutput {
  const result = { ...initial };
  if (result["Coverage Status"] && !/^(?:active|inactive)$/i.test(result["Coverage Status"])) {
    result["Coverage Status"] = "";
  }
  const policy = text.match(/\b(Active|Inactive)\s*\(\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4}|Present)\s*\)/i);
  if (policy) {
    result["Coverage Status"] = policy[1][0].toUpperCase() + policy[1].slice(1).toLowerCase();
    result["Eff Date"] = policy[2];
    result["End Date"] = policy[3];
  }
  if (!result["Coverage Status"]) {
    const standaloneStatus = text.match(/(?:^|\n)\s*(Active|Inactive)\s*(?:\(|$)/im)?.[1];
    if (standaloneStatus) {
      result["Coverage Status"] = standaloneStatus[0].toUpperCase() + standaloneStatus.slice(1).toLowerCase();
    }
  }

  const planName = valueAfterLabel(text, ["Plan Name", "Insurance Type", "Coverage Type"])
    || text.match(/Policy Selected:\s*([^\r\n]+)/i)?.[1]?.trim()
    || "";
  if (planName) result["Bot Insurance Type"] = planName;
  const planType = valueAfterLabel(text, ["Plan Type", "Product Type"]);
  if (planType) result["Plan Type"] = planType;

  const network = valueAfterLabel(text, ["Network Status"]);
  const individualHeading = text.match(/\bIndividual,\s*(In-Network|Out-of-Network)\b/i)?.[1];
  if (network || individualHeading) result.Network = network || individualHeading || "";

  const individual = section(text, /\bIndividual,\s*(?:In-Network|Out-of-Network)\b/i, /\b(?:Family,|Popular Services Coverage)\b/i)
    || section(text, /Deductibles\s*&\s*Maximums/i, /Popular Services Coverage/i)
    || text;
  const deductible = metAndTotal(individual, /Plan\s+Deductible\s+Per\s+Calendar\s+Year/i)
    ?? metAndTotal(text, /Plan\s+Deductible\s+Per\s+Calendar\s+Year/i);
  if (deductible) {
    result.Deductible = deductible.total;
    result["Deductible Met"] = deductible.met;
  }
  const outOfPocket = metAndTotal(individual, /Out-of-Pocket\s+Maximum\s+Per\s+Calendar\s+Year/i)
    ?? metAndTotal(text, /Out-of-Pocket\s+Maximum\s+Per\s+Calendar\s+Year/i);
  if (outOfPocket) {
    result["Out of Pocket"] = outOfPocket.total;
    result["Out of Pocket Met"] = outOfPocket.met;
  }

  const specialist = specialistBenefits(text);
  if (specialist.copay) result.Copay = specialist.copay;
  if (specialist.coinsurance) result.Coinsurance = specialist.coinsurance;

  const payerStatus = text.match(/UHC Payer Status\s*[:-]?\s*(Primary|Secondary|Tertiary)/i)?.[1] ?? "";
  if (/^primary$/i.test(payerStatus)) {
    result["Other Ins"] = "";
    result["Other Ins Eff Date"] = "";
  } else if (payerStatus) {
    result["Other Ins"] = valueAfterLabel(text, ["Other Insurance", "Other Payer", "Payer Name"]);
    result["Other Ins Eff Date"] = valueAfterLabel(text, ["Other Insurance Effective Date", "Other Payer Effective Date", "Effective Date"]);
  }

  return result;
}
