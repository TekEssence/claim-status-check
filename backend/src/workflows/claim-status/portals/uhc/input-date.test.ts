import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUhcInputDate } from './automation';

test('UHC preserves the calendar date in service timestamps across timezone offsets', () => {
  for (const value of [
    '2026-08-25T00:00:00+05:30',
    '2026-08-25T23:30:00-07:00',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25',
  ]) assert.equal(normalizeUhcInputDate(value), '08/25/2026');
});

test('UHC retains existing slash dates, Excel serials and Date support', () => {
  for (const value of ['8/25/2026', '08/25/2026', '8-25-26', 46259, '46259', new Date('2026-08-25T00:00:00Z')]) {
    assert.equal(normalizeUhcInputDate(value), '08/25/2026');
  }
});

test('UHC rejects invalid calendar dates and malformed timestamps', () => {
  for (const value of ['', '2026-02-30T00:00:00+05:30', '2026-13-25', '2026-08-25T99:00:00Z', '8/32/2026', 'not a date']) {
    assert.equal(normalizeUhcInputDate(value), '');
  }
});
