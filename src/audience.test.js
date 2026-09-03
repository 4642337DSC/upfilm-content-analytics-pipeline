import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween } from './audience.js';

test('daysBetween counts whole days across a month boundary', () => {
  assert.equal(daysBetween('2026-08-02', '2026-09-02'), 31);
  assert.equal(daysBetween('2026-07-31', '2026-08-31'), 31);
  assert.equal(daysBetween('2026-08-31', '2026-08-31'), 0);
});

test('daysBetween is unaffected by DST (uses UTC)', () => {
  // Europe/Bucharest switches DST on 2026-03-29; still exactly 2 days.
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
});
