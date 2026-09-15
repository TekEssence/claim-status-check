import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { selectMediCalCalendarDate } from './calendar';
import { mediCalCalendarFixture } from './calendar-fixture';

test('Medi-Cal supports Month and Year custom dropdowns identified only by their arrow icons', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(mediCalCalendarFixture());
    await page.evaluate(() => {
      for (const id of ['month', 'year']) {
        const select = document.getElementById(id) as HTMLSelectElement;
        select.hidden = true;
        const trigger = document.createElement('div');
        trigger.tabIndex = 0;
        const value = document.createElement('span');
        const arrow = document.createElement('span');
        arrow.textContent = '▼';
        arrow.className = 'ca-gov-icon-triangle-down DropDown-module__dropDownComponentIcon__2JZy2';
        trigger.append(value, arrow);
        select.after(trigger);
        trigger.onclick = () => {
          document.getElementById('custom-options')?.remove();
          const menu = document.createElement('div'); menu.id = 'custom-options';
          for (const option of Array.from(select.options)) {
            const item = document.createElement('div'); item.textContent = option.text;
            item.onclick = () => {
              select.value = option.value; value.textContent = option.text;
              select.dispatchEvent(new Event('change')); menu.remove();
            };
            menu.appendChild(item);
          }
          document.body.appendChild(menu);
        };
      }
    });
    await selectMediCalCalendarDate(page, '#birth-date', '02/29/1960');
    assert.equal(await page.locator('#birth-date').inputValue(), '02/29/1960');
    await selectMediCalCalendarDate(page, '#issue-date', '09/10/2026');
    assert.equal(await page.locator('#issue-date').inputValue(), '09/10/2026');
  } finally { await browser.close(); }
});

test('Medi-Cal calendar confirms all three read-only dates, including an old birth year', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(mediCalCalendarFixture());
    for (const [selector, date] of [['#issue-date', '09/10/2026'], ['#birth-date', '02/29/1960'], ['#service-date', '12/31/2025']]) {
      await selectMediCalCalendarDate(page, selector, date);
      assert.equal(await page.locator(selector).inputValue(), date);
      assert.equal(await page.locator(selector).getAttribute('data-confirmed'), 'true');
    }
    await assert.rejects(selectMediCalCalendarDate(page, '#birth-date', '02/30/1960'), /invalid date/);
    await page.locator('#issue-date').click();
    await page.locator('[id^="day-"][id$="-issue-date"]').filter({ hasText: /^10$/ }).locator('..').evaluate(element => element.setAttribute('disabled', ''));
    // Reject an unavailable date without advancing to another field.
    await page.evaluate(() => { (window as unknown as { renderDays: () => void }).renderDays = () => {}; });
    await assert.rejects(selectMediCalCalendarDate(page, '#issue-date', '09/10/2026'), /unavailable/);
  } finally { await browser.close(); }
});
