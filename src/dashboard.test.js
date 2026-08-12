import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardRow, renderClientLinks, buildVideoDetail, claudeScoresOrNull, buildLongFormRow } from './dashboard.js';

function page(props) {
  return { properties: props };
}

test('buildDashboardRow reads view counts from cfg-configured field names', () => {
  var cfg = {
    YT_FIELD_NAME: 'V7Z - Yt Shorts',
    FB_FIELD_NAME: 'V7Z - Fb',
    IG_FIELD_NAME: 'V7Z - Insta',
    TT_FIELD_NAME: 'V7Z - TikTok'
  };
  var p = page({
    'Data Postare': { date: { start: '2026-08-01' } },
    'Name': { title: [{ plain_text: 'Test Short' }] },
    'Cod': { rich_text: [{ plain_text: 'M001' }] },
    'Instagram URL': { url: 'https://instagram.com/p/x' },
    'YouTube URL': null,
    'Facebook URL': null,
    'TikTok URL': null,
    'V7Z - Yt Shorts': { number: 10 },
    'V7Z - Fb': { number: 20 },
    'V7Z - Insta': { number: 30 },
    'V7Z - TikTok': { number: 40 },
    'Transcript': { rich_text: [{ plain_text: 'hello' }] }
  });

  var row = buildDashboardRow(cfg, p, { M001: 'thumb.jpg' });

  assert.deepEqual(row, [
    'Test Short', 'M001', 10, 20, 30, 40,
    '2026-08-01', 'https://instagram.com/p/x', 'hello', 'thumb.jpg'
  ]);
});

test('buildDashboardRow returns null when there is no post date', () => {
  var cfg = { YT_FIELD_NAME: 'YouTube', FB_FIELD_NAME: 'Facebook', IG_FIELD_NAME: 'Instagram', TT_FIELD_NAME: 'TikTok' };
  var p = page({
    'Data Postare': { date: null },
    'Name': { title: [] },
    'Cod': { rich_text: [] }
  });

  assert.equal(buildDashboardRow(cfg, p, {}), null);
});

test('buildVideoDetail reads the written hook from the "Written Hook" property', () => {
  var p = page({
    'Duration (s)': { number: 34 },
    'Written Hook': { rich_text: [{ plain_text: 'If your lawn is turning brown, ' }, { plain_text: "it's not the heat." }] }
  });

  var detail = buildVideoDetail(p);

  assert.equal(detail.hook, "If your lawn is turning brown, it's not the heat.");
});

test('buildVideoDetail returns null hook when "Written Hook" is absent', () => {
  var p = page({
    'Duration (s)': { number: 34 }
  });

  var detail = buildVideoDetail(p);

  assert.equal(detail.hook, null);
});

test('claudeScoresOrNull reads all five scores plus notes/performance/pattern', () => {
  var p = {
    'Hook Score': { number: 7 },
    'Structure Score': { number: 8 },
    'Format Score': { number: 6 },
    'Pacing Score': { number: 5 },
    'CTA Score': { number: 2 },
    'Overall Notes': { rich_text: [{ plain_text: 'Strong hook, weak CTA.' }] },
    'Performance Notes': { rich_text: [{ plain_text: 'Underperformed baseline mainly due to the missing CTA.' }] },
    'Reusable Pattern': { rich_text: [{ plain_text: 'Open with a contrarian claim.' }] }
  };

  assert.deepEqual(claudeScoresOrNull(p), {
    hookScore: 7, structureScore: 8, formatScore: 6, pacingScore: 5, ctaScore: 2,
    overallNotes: 'Strong hook, weak CTA.',
    performanceNotes: 'Underperformed baseline mainly due to the missing CTA.',
    reusablePattern: 'Open with a contrarian claim.'
  });
});

test('claudeScoresOrNull returns null when the row has not been scored yet (no Hook Score)', () => {
  assert.equal(claudeScoresOrNull({}), null);
});

test('claudeScoresOrNull falls back to null notes/performance/pattern when those rich_text properties are absent', () => {
  var p = { 'Hook Score': { number: 4 } };
  var scores = claudeScoresOrNull(p);
  assert.equal(scores.overallNotes, null);
  assert.equal(scores.performanceNotes, null);
  assert.equal(scores.reusablePattern, null);
});

test('buildLongFormRow reads views from cfg.LONG_FORM_YT_FIELD_NAME and the plain YT metric properties', () => {
  var cfg = { LONG_FORM_YT_FIELD_NAME: 'YT Views' };
  var p = page({
    'Data Postare': { date: { start: '2026-08-05' } },
    'Name': { title: [{ plain_text: 'Totul despre fundatii' }] },
    'Cod': { rich_text: [{ plain_text: '26-06' }] },
    'YouTube URL': { url: 'https://www.youtube.com/watch?v=pUNuBwr0bRM' },
    'YT Views': { number: 657 },
    'Duration (s)': { number: 3384 },
    'YT Likes': { number: 33 },
    'YT Comments': { number: 1 },
    'YT Hook Rate': { number: 42.5 },
    'YT Avg Watch %': { number: 12.3 }
  });

  var row = buildLongFormRow(cfg, p);

  assert.deepEqual(row, [
    'Totul despre fundatii', '26-06', 657, '2026-08-05',
    'https://www.youtube.com/watch?v=pUNuBwr0bRM', 3384, 33, 1, 42.5, 12.3
  ]);
});

test('buildLongFormRow returns null when there is no post date', () => {
  var cfg = { LONG_FORM_YT_FIELD_NAME: 'YT Views' };
  var p = page({
    'Data Postare': { date: null },
    'Name': { title: [] },
    'Cod': { rich_text: [] }
  });

  assert.equal(buildLongFormRow(cfg, p), null);
});

test('buildLongFormRow returns null for missing numeric metrics rather than throwing', () => {
  var cfg = { LONG_FORM_YT_FIELD_NAME: 'YT Views' };
  var p = page({
    'Data Postare': { date: { start: '2026-08-05' } },
    'Name': { title: [{ plain_text: 'Unposted draft' }] },
    'Cod': { rich_text: [{ plain_text: '26-07' }] },
    'YouTube URL': null
  });

  var row = buildLongFormRow(cfg, p);

  assert.deepEqual(row, ['Unposted draft', '26-07', null, '2026-08-05', null, null, null, null, null, null]);
});

test('renderClientLinks renders one link per slug, sorted, label uppercased', () => {
  var html = renderClientLinks(['miradex', 'isogreen']);

  assert.equal(
    html,
    '      <li><a href="/clients/isogreen/">ISOGREEN</a></li>\n' +
    '      <li><a href="/clients/miradex/">MIRADEX</a></li>'
  );
});
