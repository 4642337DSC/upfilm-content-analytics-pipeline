import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRetentionAtWindow } from './youtube.js';

test('pickRetentionAtWindow defaults to the 3s window when none is given (Shorts convention)', () => {
  var duration = 30; // 3s -> elapsed ratio 0.1
  var retention = { '0.05': 0.9, '0.1': 0.8, '0.15': 0.7 };

  assert.equal(pickRetentionAtWindow(retention, duration), 80);
});

test('pickRetentionAtWindow honors a longer windowSeconds for Long Form content', () => {
  var duration = 600; // 10 min video, 30s -> elapsed ratio 0.05
  var retention = { '0.01': 0.95, '0.05': 0.62, '0.1': 0.5 };

  assert.equal(pickRetentionAtWindow(retention, duration, 30), 62);
});

test('pickRetentionAtWindow picks the closest bucket when the exact ratio is not a key', () => {
  var duration = 100; // 30s -> elapsed ratio 0.3
  var retention = { '0.2': 0.9, '0.31': 0.55, '0.4': 0.4 };

  assert.equal(pickRetentionAtWindow(retention, duration, 30), 55);
});

test('pickRetentionAtWindow returns null when retention or duration is missing', () => {
  assert.equal(pickRetentionAtWindow(null, 100, 30), null);
  assert.equal(pickRetentionAtWindow({ '0.1': 0.5 }, null, 30), null);
});
