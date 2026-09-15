import type { Frame, Page } from "playwright-core";

export async function readMemberResponseFields(scope: Page | Frame) {
  return scope.evaluate(() => {
    const labels = {
      effectiveDate: "Current Plan Effective Date",
      relationship: "Relationship to Subscriber",
      planDate: "Period Start Date",
      insuranceType: "Insurance Type",
      planType: "Plan / Product",
    };
    const clean = (text: string) => text.replace(/\s+/g, " ").trim();
    const normalize = (text: string) => clean(text).replace(/:\s*$/, "").toLowerCase();
    const visible = (element: Element) => element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== "hidden";
    const elements = Array.from(document.querySelectorAll("div, span, dt, label, p, th, td"));
    const labelNames = Object.values(labels).map(normalize);
    const read = (label: string) => {
      const matches = elements.filter(element => visible(element)
        && normalize(element.textContent || "") === normalize(label)
        && !Array.from(element.children).some(child => normalize(child.textContent || "") === normalize(label)));
      for (const element of matches) {
        // Read the smallest field container, including text nodes and nested
        // value wrappers. Never cross into a container holding other fields.
        let container: Element | null = element.parentElement;
        for (let depth = 0; container && depth < 3; depth++, container = container.parentElement) {
          const text = clean((container as HTMLElement).innerText || "");
          const normalized = normalize(text);
          if (labelNames.some(other => other !== normalize(label) && normalized.includes(other))) break;
          if (!normalized.startsWith(normalize(label))) break;
          const value = text.slice(clean(element.textContent || "").length).replace(/^\s*:\s*/, "").trim();
          if (value) return value;
        }
      }
      return "";
    };
    return {
      effectiveDate: read(labels.effectiveDate), relationship: read(labels.relationship),
      planDate: read(labels.planDate), insuranceType: read(labels.insuranceType), planType: read(labels.planType),
    };
  });
}

export async function waitForMemberResponseFields(scope: Page | Frame, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let fields = await readMemberResponseFields(scope);
  while (Object.values(fields).some(value => !value) && Date.now() < deadline) {
    await scope.waitForTimeout(200);
    fields = await readMemberResponseFields(scope);
  }
  return fields;
}
