import type { Frame, Locator, Page } from "playwright-core";

type PortalScope = Page | Frame;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  for (const alias of aliases) {
    const match = Object.entries(row).find(([key, value]) =>
      normalizeKey(key) === normalizeKey(alias) && String(value ?? "").trim(),
    );
    if (match) return String(match[1]).trim();
  }
  return "";
}

export function resolveAvailityPatientName(row: Record<string, unknown>): { firstName: string; lastName: string } {
  const firstName = findValue(row, ["Patient First Name", "Patient F Name", "First Name", "Pat First Name", "Pat F Name", "Member First Name", "Subscriber First Name"]);
  const lastName = findValue(row, ["Patient Last Name", "Patient L Name", "Last Name", "Pat Last Name", "Pat L Name", "Member Last Name", "Subscriber Last Name"]);
  if (firstName || lastName) return { firstName, lastName };

  const fullName = findValue(row, ["Patient Name", "Patient Full Name", "Member Name", "Subscriber Name", "Patient"]).replace(/\s+/g, " ").trim();
  if (!fullName) return { firstName: "", lastName: "" };
  if (fullName.includes(",")) {
    const [lastName, firstName = ""] = fullName.split(",", 2).map((part) => part.trim());
    return { firstName: firstName.split(" ")[0] || "", lastName };
  }
  // Retain the existing workbook convention: LAST FIRST or LAST M FIRST.
  const parts = fullName.split(" ").filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.length >= 3 && parts[1].length === 1 ? parts[2] : parts[1], lastName: parts[0] };
}

function nameInput(page: PortalScope, label: string, field: string): Locator {
  return page.getByLabel(new RegExp(`^${label}\\s*\\*?$`, "i"))
    .or(page.locator(`input[name='${field}'], input[id='${field}'], input[aria-label='${label}']`))
    .filter({ visible: true }).first();
}

async function chooseNameSearch(page: PortalScope): Promise<void> {
  const desired = "Patient ID, Patient Last Name, Patient First Name, Date of Birth";
  let control = page.getByLabel(/^Patient Search Option\b/i).filter({ visible: true }).first();
  if (!await control.isVisible()) {
    let container = page.getByText("Patient Search Option", { exact: true }).first().locator("xpath=..");
    for (let depth = 0; depth < 5; depth += 1) {
      const candidate = container.locator("[role='combobox'], select, button, input").filter({ visible: true }).first();
      if (await candidate.isVisible()) { control = candidate; break; }
      container = container.locator("xpath=..");
    }
  }
  if (!await control.isVisible()) return;
  if (await control.evaluate((element) => element.tagName === "SELECT")) {
    if (await control.locator("option").filter({ hasText: desired }).count()) {
      await control.selectOption({ label: desired });
      await pause(500);
    }
    return;
  }
  const text = [await control.inputValue().catch(() => ""), await control.getAttribute("aria-valuetext"), await control.innerText()].join(" ");
  if (text.includes(desired)) return;
  await control.scrollIntoViewIfNeeded();
  await control.click({ timeout: 5_000 });
  const option = page.getByRole("option", { name: desired, exact: true })
    .or(page.getByText(desired, { exact: true })).filter({ visible: true }).first();
  if (!await option.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false)) {
    await control.press("Escape");
    return;
  }
  await option.click({ timeout: 5_000 });
  await pause(500);
}

async function enterName(input: Locator, value: string, label: string): Promise<void> {
  await input.fill("");
  await input.pressSequentially(value, { delay: 150 });
  await input.press("Tab");
  await pause(350);
  if ((await input.inputValue()).trim() !== value) {
    throw new Error(`${label} did not retain the value entered from the input workbook.`);
  }
}

export async function fillAvailityPatientName(
  page: PortalScope,
  row: Record<string, unknown>,
  preferNameSearch = false,
): Promise<void> {
  const name = resolveAvailityPatientName(row);
  if (preferNameSearch || (name.firstName && name.lastName)) await chooseNameSearch(page);
  const first = nameInput(page, "Patient First Name", "patientFirstName");
  const last = nameInput(page, "Patient Last Name", "patientLastName");
  const visibleFirst = await first.isVisible();
  const visibleLast = await last.isVisible();
  const missing: string[] = [];
  for (const [input, visible, value, label] of [
    [first, visibleFirst, name.firstName, "Patient First Name"],
    [last, visibleLast, name.lastName, "Patient Last Name"],
  ] as const) {
    if (!visible || value) continue;
    const required = preferNameSearch || await input.getAttribute("required") !== null
      || await input.getAttribute("aria-required") === "true";
    if (required) missing.push(label);
  }
  if (missing.length) throw new Error(`Missing ${missing.join(" or ")} in the input workbook for the selected patient search option.`);
  // Clear optional fields too, so a previous patient's name cannot carry over.
  if (visibleLast) await enterName(last, name.lastName, "Patient Last Name");
  if (visibleFirst) await enterName(first, name.firstName, "Patient First Name");
}
