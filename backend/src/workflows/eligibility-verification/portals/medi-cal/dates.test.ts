import test from 'node:test';
import assert from 'node:assert/strict';
import { mediCalDatesMatch, mediCalIssueDate } from './dates';

test('Medi-Cal accepts long calendar display dates while rejecting different and invalid dates', () => {
  assert.equal(mediCalDatesMatch('September 10, 2026', '09/10/2026'), true);
  assert.equal(mediCalDatesMatch('January 2, 1960', '01/02/1960'), true);
  assert.equal(mediCalDatesMatch('9/10/2026', '09/10/2026'), true);
  assert.equal(mediCalDatesMatch('September 11, 2026', '09/10/2026'), false);
  assert.equal(mediCalDatesMatch('February 30, 2026', '02/30/2026'), false);
  assert.equal(mediCalDatesMatch('', ''), false);
});

test('Medi-Cal issue date switches from yesterday to today at 3 PM IST', () => {
  assert.equal(mediCalIssueDate(new Date('2026-09-11T09:29:59Z')), '09/10/2026');
  assert.equal(mediCalIssueDate(new Date('2026-09-11T09:30:00Z')), '09/11/2026');
  assert.equal(mediCalIssueDate(new Date('2026-09-11T18:29:59Z')), '09/11/2026');
});

test('Medi-Cal issue date handles year boundaries and leap days', () => {
  assert.equal(mediCalIssueDate(new Date('2026-01-01T03:00:00Z')), '12/31/2025');
  assert.equal(mediCalIssueDate(new Date('2024-03-01T03:00:00Z')), '02/29/2024');
});
