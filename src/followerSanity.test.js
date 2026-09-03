import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roundToSigFigs,
  looksApiRounded,
  isImplausibleFollowerCount,
  latestPreciseSnapshot
} from './followerSanity.js';

test('roundToSigFigs matches YouTube Data API 3-sig-fig rounding', () => {
  assert.equal(roundToSigFigs(12154, 3), 12200);
  assert.equal(roundToSigFigs(12100, 3), 12100);
  assert.equal(roundToSigFigs(12149, 3), 12100);
  assert.equal(roundToSigFigs(999, 3), 999); // under 1000: untouched by 3 sig figs
  assert.equal(roundToSigFigs(0, 3), 0);
});

test('looksApiRounded flags values that equal their own 3-sig-fig rounding at >=1000', () => {
  assert.equal(looksApiRounded(12100), true);
  assert.equal(looksApiRounded(12154), false);
  assert.equal(looksApiRounded(12156), false);
  assert.equal(looksApiRounded(900), false);   // API is exact below 1000
  assert.equal(looksApiRounded(0), false);
  assert.equal(looksApiRounded(null), false);
});

test('isImplausibleFollowerCount rejects non-positive and missing counts', () => {
  assert.equal(isImplausibleFollowerCount(0, 22131), true);       // the Zernio 0
  assert.equal(isImplausibleFollowerCount(-5, 22131), true);
  assert.equal(isImplausibleFollowerCount(null, 22131), true);
  assert.equal(isImplausibleFollowerCount(undefined, 22131), true);
});

test('isImplausibleFollowerCount rejects a >25% single-capture swing', () => {
  assert.equal(isImplausibleFollowerCount(22, 22131), true);      // transient partial response
  assert.equal(isImplausibleFollowerCount(30000, 22131), true);   // +35%
  assert.equal(isImplausibleFollowerCount(22172, 22131), false);  // a normal day
  assert.equal(isImplausibleFollowerCount(12156, 12154), false);
});

test('isImplausibleFollowerCount accepts any positive count when there is no prior', () => {
  assert.equal(isImplausibleFollowerCount(22131, null), false);
  assert.equal(isImplausibleFollowerCount(22131, 0), false);
});

test('latestPreciseSnapshot skips rounded and zero tail entries', () => {
  var series = [
    { date: '2026-07-31', value: 12154 },
    { date: '2026-08-02', value: 12156 },
    { date: '2026-08-05', value: 12100 },
    { date: '2026-09-02', value: 12100 }
  ];
  assert.deepEqual(latestPreciseSnapshot(series), { date: '2026-08-02', value: 12156 });
});

test('latestPreciseSnapshot returns null when every entry is rounded or zero', () => {
  assert.equal(latestPreciseSnapshot([{ date: '2026-08-05', value: 12100 }, { date: '2026-08-06', value: 0 }]), null);
  assert.equal(latestPreciseSnapshot([]), null);
});
