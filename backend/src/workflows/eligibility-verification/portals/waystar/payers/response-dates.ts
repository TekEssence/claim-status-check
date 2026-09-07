/** Runs in the response page, independently of benefit-section detection. */
export function extractWaystarResponseDates() {
  const dateOnly = (value: string | undefined): string | undefined => {
    const clean = value?.replace(/\s+/g, " ").trim();
    return clean && /^(?:\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})$/.test(clean) ? clean : undefined;
  };
  const read = (label: string, root: ParentNode = document): string | undefined => {
    const normalized = (value: string) => value.replace(/\s+/g, " ").trim().replace(/:$/, "").toLowerCase();
    for (const element of Array.from(root.querySelectorAll(".Label, td, th, dt, span, div, label, strong"))) {
      if (normalized(element.textContent ?? "") !== normalized(label)) continue;
      // Labels can be nested in a span inside a table cell or a row wrapper.
      // Walk only label-only ancestors and read the adjacent value, never an
      // arbitrary date from a shared coverage card.
      let current: Element | null = element;
      for (let depth = 0; current && depth < 4; depth += 1) {
        if (normalized(current.textContent ?? "") !== normalized(label)) break;
        const value = dateOnly(current.nextElementSibling?.textContent ?? undefined);
        if (value) return value;
        current = current.parentElement;
      }
    }
    // Legacy response layouts may use table cells or text wrappers rather
    // than Label/Text classes. Match the exact label followed immediately by
    // a date in rendered text; never take a nearby differently labelled date.
    const body = root === document ? document.body?.innerText ?? "" : root.textContent ?? "";
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = body.match(new RegExp(`(?:^|[\\n\\t])\\s*${escaped}\\s*:?\\s+(\\d{1,2}/\\d{1,2}/\\d{4}|\\d{4}-\\d{2}-\\d{2})(?=\\s|$)`, "i"));
    if (match) return dateOnly(match[1]);
    return undefined;
  };
  // MedRevenue Aetna uses subscriber eligibility; UMR uses other benefits.
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  const readSection = (title: string, label: string) => headings.flatMap((heading, index) => {
    if (heading.textContent?.replace(/\s+/g, " ").trim().replace(/:$/, "").toLowerCase() !== title) return [];
    const range = document.createRange();
    range.setStartAfter(heading);
    const nextHeading = headings.slice(index + 1).find(next => next.tagName <= heading.tagName);
    if (nextHeading) range.setEndBefore(nextHeading);
    else range.setEndAfter(document.body.lastChild ?? heading);
    return [range.cloneContents()];
  }).map(section => read(label, section)).find(value => value !== undefined);
  return {
    eligibilityBeginDate: readSection("subscriber coverage information", "Eligibility Begin Date"),
    benefitBeginDate: readSection("other coverage information", "Benefit Begin Date"),
    planBeginDate: read("Plan Begin Date"),
  };
}
