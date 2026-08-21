import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacebookVideoId } from './facebook.js';

test('extractFacebookVideoId reads the ID out of a /reel/ URL', () => {
  assert.equal(extractFacebookVideoId('https://www.facebook.com/reel/1595448391764177'), '1595448391764177');
});

test('extractFacebookVideoId reads the ID out of a legacy /videos/ URL', () => {
  assert.equal(extractFacebookVideoId('https://www.facebook.com/MiradexPage/videos/1234567890123456/'), '1234567890123456');
});

test('extractFacebookVideoId returns null for a non-Facebook-video URL', () => {
  assert.equal(extractFacebookVideoId('https://www.facebook.com/MiradexPage/photos/a.123/456/'), null);
});

test('extractFacebookVideoId returns null for a missing URL', () => {
  assert.equal(extractFacebookVideoId(null), null);
  assert.equal(extractFacebookVideoId(''), null);
});
