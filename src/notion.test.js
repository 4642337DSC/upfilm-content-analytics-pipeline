import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShortsFilter, buildUpdatePayloads } from './notion.js';

test('buildShortsFilter includes the Tip clause when NOTION_FILTER_TIP is true', () => {
  var filter = buildShortsFilter({ NOTION_FILTER_TIP: true });
  assert.deepEqual(filter, {
    and: [
      { property: 'Tip', multi_select: { contains: 'Short' } },
      { property: 'Postat?', checkbox: { equals: true } }
    ]
  });
});

test('buildShortsFilter omits the Tip clause when NOTION_FILTER_TIP is false', () => {
  var filter = buildShortsFilter({ NOTION_FILTER_TIP: false });
  assert.deepEqual(filter, {
    and: [{ property: 'Postat?', checkbox: { equals: true } }]
  });
});

test('buildUpdatePayloads writes counts into the cfg-configured field names', () => {
  var cfg = {
    YT_FIELD_NAME: 'V7Z - Yt Shorts',
    FB_FIELD_NAME: 'V7Z - Fb',
    IG_FIELD_NAME: 'V7Z - Insta',
    TT_FIELD_NAME: 'V7Z - TikTok'
  };
  var row = { pageId: 'page-1' };
  var yt = { results: [{ row: row, views: 100, url: 'https://youtu.be/x' }] };
  var fb = { results: [{ row: row, views: 50 }] };

  var payloads = buildUpdatePayloads(cfg, [row], yt, fb, null, null);

  assert.deepEqual(payloads, {
    'page-1': {
      'V7Z - Yt Shorts': { number: 100 },
      'YouTube URL': { url: 'https://youtu.be/x' },
      'V7Z - Fb': { number: 50 }
    }
  });
});

test('buildUpdatePayloads skips platforms passed as null', () => {
  var cfg = { YT_FIELD_NAME: 'YouTube', FB_FIELD_NAME: 'Facebook', IG_FIELD_NAME: 'Instagram', TT_FIELD_NAME: 'TikTok' };
  var row = { pageId: 'page-1' };
  var yt = { results: [{ row: row, views: 5 }] };

  var payloads = buildUpdatePayloads(cfg, [row], yt, null, null, null);

  assert.deepEqual(payloads, { 'page-1': { YouTube: { number: 5 } } });
});

test('buildUpdatePayloads writes the retention window to cfg.RETENTION_WINDOW_FIELD_NAME', () => {
  var cfg = { YT_FIELD_NAME: 'YT Views', RETENTION_WINDOW_FIELD_NAME: 'YT Retention @30s' };
  var row = { pageId: 'page-1' };
  var yt = { results: [{ row: row, views: 100, retentionAtWindow: 62 }] };

  var payloads = buildUpdatePayloads(cfg, [row], yt, null, null, null);

  assert.deepEqual(payloads['page-1']['YT Retention @30s'], { number: 62 });
});

test('buildUpdatePayloads writes Name from youtubeTitle only when SYNC_TITLE_FROM_YOUTUBE is on', () => {
  var row = { pageId: 'page-1' };
  var yt = { results: [{ row: row, views: 100, youtubeTitle: 'Real Published Title' }] };

  var onCfg = { YT_FIELD_NAME: 'YT Views', SYNC_TITLE_FROM_YOUTUBE: true };
  var onPayloads = buildUpdatePayloads(onCfg, [row], yt, null, null, null);
  assert.deepEqual(onPayloads['page-1']['Name'], { title: [{ text: { content: 'Real Published Title' } }] });

  var offCfg = { YT_FIELD_NAME: 'YT Views', SYNC_TITLE_FROM_YOUTUBE: false };
  var offPayloads = buildUpdatePayloads(offCfg, [row], yt, null, null, null);
  assert.equal(offPayloads['page-1']['Name'], undefined);
});

test('buildUpdatePayloads leaves Name untouched when youtubeTitle is null even with sync enabled', () => {
  var row = { pageId: 'page-1' };
  var yt = { results: [{ row: row, views: 100, youtubeTitle: null }] };
  var cfg = { YT_FIELD_NAME: 'YT Views', SYNC_TITLE_FROM_YOUTUBE: true };

  var payloads = buildUpdatePayloads(cfg, [row], yt, null, null, null);

  assert.equal(payloads['page-1']['Name'], undefined);
});

test('buildUpdatePayloads writes impressions/CTR only when field names are configured', () => {
  var row = { pageId: 'page-1' };
  var yt = { results: [{ row: row, views: 100, impressions: 5000, impressionsCtr: 4.2 }] };

  var onCfg = { YT_FIELD_NAME: 'YT Views', IMPRESSIONS_FIELD_NAME: 'YT Impressions', IMPRESSIONS_CTR_FIELD_NAME: 'YT Impressions CTR' };
  var onPayloads = buildUpdatePayloads(onCfg, [row], yt, null, null, null);
  assert.deepEqual(onPayloads['page-1']['YT Impressions'], { number: 5000 });
  assert.deepEqual(onPayloads['page-1']['YT Impressions CTR'], { number: 4.2 });

  var offCfg = { YT_FIELD_NAME: 'YT Views', IMPRESSIONS_FIELD_NAME: null, IMPRESSIONS_CTR_FIELD_NAME: null };
  var offPayloads = buildUpdatePayloads(offCfg, [row], yt, null, null, null);
  assert.equal(offPayloads['page-1']['YT Impressions'], undefined);
  assert.equal(offPayloads['page-1']['YT Impressions CTR'], undefined);
});
