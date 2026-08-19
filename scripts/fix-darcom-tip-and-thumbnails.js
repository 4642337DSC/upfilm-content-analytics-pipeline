import { getConfig, requireConfig } from '../src/config.js';
import { queryNotionDatabase, extractThumbnailUrl, updateNotionPage } from '../src/notion.js';
import { fetchAllYouTubeVideos, fetchYouTubeViewCounts, extractYouTubeId } from '../src/youtube.js';
import { fetchAllFacebookVideos } from '../src/facebook.js';
import { fetchAllInstagramMedia } from '../src/instagram.js';

// One-off correction for the 99 rows scripts/backfill-darcom-2026-videos.js
// just created:
//  1. Re-classifies Tip using YouTube's real Shorts boundary (180s, not the
//     60s this codebase uses elsewhere for a different purpose - see that
//     script's SHORT_MAX_SECONDS comment) - only genuinely long-form
//     YouTube uploads should be "Long"; everything else (including
//     FB/IG-only rows, which never had a YouTube duration to check) is
//     "Short".
//  2. Sets the "Thumbnail" file property (external URL) for every row that
//     doesn't have one yet: YouTube's stable hqdefault.jpg when a YouTube
//     URL is present, else the matched Facebook Reel's picture, else the
//     matched Instagram media's thumbnail_url.

var SHORT_MAX_SECONDS = 180;
var YEAR_PREFIX = '2026';

var cfg = getConfig();
requireConfig(cfg);

// Local parser (not notion.js's parseNotionRow) - that one only extracts
// the fields the regular sync needs (no Tip, no Facebook URL, no Name).
function parseRow(page) {
  var props = page.properties;
  var name = (props['Name'].title || []).map(function (t) { return t.plain_text; }).join('');
  return {
    pageId: page.id,
    name: name,
    tip: props['Tip'] && props['Tip'].select ? props['Tip'].select.name : null,
    youtubeUrl: props['YouTube URL'] ? props['YouTube URL'].url : null,
    facebookUrl: props['Facebook URL'] ? props['Facebook URL'].url : null,
    instagramUrl: props['Instagram URL'] ? props['Instagram URL'].url : null,
    thumbnailUrl: extractThumbnailUrl(props['Thumbnail'])
  };
}

async function fetchAllRows(cfg) {
  var rows = [];
  var cursor = null;
  do {
    var payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, cfg.NOTION_DATABASE_ID, payload);
    if (data.object === 'error') throw new Error('Notion query failed: ' + data.message);
    (data.results || []).forEach(function (page) { rows.push(parseRow(page)); });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

function isIn2026(dateStr) {
  return typeof dateStr === 'string' && dateStr.slice(0, 4) === YEAR_PREFIX;
}

console.log('Fetching Notion rows...');
var rows = await fetchAllRows(cfg);
// Only touch rows this backfill created - has at least one platform URL set.
var target = rows.filter(function (r) { return r.youtubeUrl || r.instagramUrl || r.facebookUrl; });
console.log('  ' + rows.length + ' total rows, ' + target.length + ' with a platform URL to fix.');

console.log('Fetching YouTube uploads (for durations + IDs)...');
var ytVideos = (await fetchAllYouTubeVideos(cfg)).filter(function (v) { return isIn2026(v.publishedAt); });
var ytStats = await fetchYouTubeViewCounts(cfg, ytVideos.map(function (v) { return v.id; }));

console.log('Fetching Facebook Reels (for thumbnail fallback)...');
var fbVideos = (await fetchAllFacebookVideos(cfg)).filter(function (v) { return isIn2026(v.publishedAt); });
var fbByPermalink = {};
fbVideos.forEach(function (v) { if (v.permalink) fbByPermalink[v.permalink] = v; });

console.log('Fetching Instagram media (for thumbnail fallback)...');
var igMedia = (await fetchAllInstagramMedia(cfg)).filter(function (v) { return isIn2026(v.publishedAt); });
var igByPermalink = {};
igMedia.forEach(function (v) { if (v.permalink) igByPermalink[v.permalink] = v; });

var fixedTip = 0, setThumb = 0;
for (var row of target) {
  var props = {};

  // ---- Tip re-classification ----
  var ytId = row.youtubeUrl ? extractYouTubeId(row.youtubeUrl) : null;
  var duration = ytId && ytStats[ytId] ? ytStats[ytId].duration : null;
  var correctTip = (typeof duration === 'number' && duration >= SHORT_MAX_SECONDS) ? 'Long' : 'Short';
  if (row.tip !== correctTip) {
    props['Tip'] = { select: { name: correctTip } };
  }

  // ---- Thumbnail ----
  if (!row.thumbnailUrl) {
    var thumbUrl = null;
    if (ytId) {
      thumbUrl = 'https://i.ytimg.com/vi/' + ytId + '/hqdefault.jpg';
    } else {
      var fb = row.facebookUrl ? fbByPermalink[row.facebookUrl] : null;
      if (fb && fb.picture) thumbUrl = fb.picture;
    }
    if (!thumbUrl && row.instagramUrl) {
      var ig = igByPermalink[row.instagramUrl];
      if (ig && ig.thumbnailUrl) thumbUrl = ig.thumbnailUrl;
    }
    if (thumbUrl) {
      props['Thumbnail'] = { files: [{ type: 'external', name: 'thumbnail.jpg', external: { url: thumbUrl } }] };
    }
  }

  if (Object.keys(props).length) {
    await updateNotionPage(cfg, row.pageId, props);
    if (props['Tip']) fixedTip++;
    if (props['Thumbnail']) setThumb++;
    console.log('  Updated: ' + row.name + (props['Tip'] ? ' [Tip -> ' + correctTip + ']' : '') + (props['Thumbnail'] ? ' [+thumbnail]' : ''));
  }
}

console.log('\nDone. Tip corrected on ' + fixedTip + ' row(s), thumbnail set on ' + setThumb + ' row(s).');
