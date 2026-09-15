import type { Locator, Page } from 'playwright-core';
import { mediCalDatesMatch } from './dates';

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

async function chooseCalendarValue(control: Locator, label: string, numericValue: number) {
  await control.waitFor({ state: 'visible', timeout: 10_000 });
  if (await control.evaluate(element => element.tagName === 'SELECT')) {
    const options = await control.locator('option').evaluateAll(elements => elements.map(element => ({
      label: element.textContent?.trim(), value: (element as HTMLOptionElement).value,
    })));
    const option = options.find(option => option.label === label)
      ?? options.find(option => option.label === String(numericValue) || option.label === String(numericValue).padStart(2, '0'));
    if (!option) throw new Error(`Medi-Cal calendar does not offer ${label}.`);
    await control.selectOption(option.value);
  } else {
    if ((await control.innerText()).trim() === label) return;
    await control.click();
    // Custom dropdowns can render their options outside the calendar panel.
    const option = control.page().getByRole('option', { name: label, exact: true })
      .or(control.page().getByText(label, { exact: true }).and(control.page().locator(':visible'))).last();
    await option.click({ timeout: 10_000 });
  }
}

async function calendarControl(panel: Locator, name: 'Month' | 'Year') {
  const labelled = panel.getByLabel(new RegExp(`^${name}\\s*\\*?$`, 'i'));
  if (await labelled.isVisible()) return labelled;
  // Month precedes Year in this portal. Include custom dropdown triggers whose
  // only identifying markup is the supplied DropDown icon (no form role).
  const controls = panel.locator('select:visible, [role="combobox"]:visible, span[class*="DropDown-module__dropDownComponentIcon__"]:visible:not([role="combobox"] span)');
  const control = controls.nth(name === 'Month' ? 0 : 1);
  await control.waitFor({ state: 'visible', timeout: 10_000 });
  if (await control.evaluate(element => element.tagName === 'SPAN')) return control.locator('..');
  return control;
}

export async function selectMediCalCalendarDate(page: Page, selector: string, date: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  if (!match) throw new Error(`Medi-Cal calendar requires a date in MM/DD/YYYY format.`);
  const [, monthText, dayText, yearText] = match;
  const month = Number(monthText), day = Number(dayText), year = Number(yearText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error('Medi-Cal calendar received an invalid date.');
  }
  const input = page.locator(selector);
  const fieldId = await input.getAttribute('id');
  if (!fieldId || !/^[a-zA-Z0-9_-]+$/.test(fieldId)) throw new Error('Medi-Cal date field has no supported calendar ID.');
  await input.click();
  const days = page.locator(`[id^="day-"][id$="-${fieldId}"]:visible`);
  await days.first().waitFor({ state: 'visible', timeout: 10_000 });
  // The portal uses empty aria-labels: locate the visible OK text inside this
  // field's calendar rather than relying on the button's accessible name.
  const panel = days.first().locator('xpath=ancestor::*[.//*[normalize-space(text())="OK"]][1]');
  const ok = panel.getByText('OK', { exact: true }).and(page.locator(':visible'));
  const monthControl = await calendarControl(panel, 'Month');
  const yearControl = await calendarControl(panel, 'Year');
  await chooseCalendarValue(yearControl, yearText, year);
  await chooseCalendarValue(monthControl, months[month - 1], month);
  const dayCell = days.filter({ hasText: new RegExp(`^${day}$`) });
  // Disabled adjacent-month dates must never be selected.
  const availableDay = dayCell.locator('xpath=ancestor::button[1][not(@disabled) and not(@aria-disabled="true") and not(contains(@class,"DatePicker-module__empty__")) and not(contains(@class,"DatePicker-module__disabled"))]');
  if (await availableDay.count() !== 1) throw new Error('Medi-Cal calendar day is unavailable or ambiguous.');
  await availableDay.click();
  await ok.click();
  await ok.waitFor({ state: 'hidden', timeout: 10_000 });
  if (!mediCalDatesMatch(await input.inputValue(), date)) throw new Error(`Medi-Cal calendar did not retain the selected date for ${fieldId} after OK.`);
}
