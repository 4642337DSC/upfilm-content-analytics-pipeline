import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, requireConfig } from './config.js';
import { fetchNotionRows, writeUpdates } from './notion.js';
import { syncYouTube, extractYouTubeId } from './youtube.js';
import { syncFacebook } from './facebook.js';
import { syncInstagram } from './instagram.js';
import { syncTikTok } from './tiktok.js';
import { syncAudience } from './audience.js';
import { syncMonthlyViews } from './monthlyViews.js';
import { syncDailyViews } from './dailyViews.js';
import { syncThumbnails } from './thumbnails.js';
import { buildDashboard } from './dashboard.js';
import { buildReportsApp } from './reports.js';
import { writeSyncSummary } from './summary.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var CLIENTS_DIR = path.join(__dirname, '..', 'dist', 'clients');

// Earliest "Data Postare" across every tracked row - the actual start of the
// account's history, used as the monthly-views lookback boundary instead of
// a fixed window, so the full available history gets pulled.
function oldestPostDate(rows) {
  var oldest = null;
  rows.forEach(function (r) {
    if (!r.postDate) return;
    var d = new Date(r.postDate + 'T00:00:00Z');
    if (!oldest || d < oldest) oldest = d;
  });
  return oldest || new Date();
}

export async function syncAllViews() {
  var cfg = getConfig();
  requireConfig(cfg);
  var DIST_DIR = path.join(CLIENTS_DIR, cfg.CLIENT_SLUG);
  var fbEnabled = !!(cfg.FB_PAGE_ID && cfg.FB_PAGE_ACCESS_TOKEN);
  var tiktokEnabled = !!(cfg.ZERNIO_API_KEY && cfg.ZERNIO_TIKTOK_ACCOUNT_ID);
  var ytEnabled = !!(cfg.YOUTUBE_OAUTH_CLIENT_ID && cfg.YOUTUBE_OAUTH_CLIENT_SECRET && cfg.YOUTUBE_REFRESH_TOKEN);

  var rows = await fetchNotionRows(cfg);

  // Notion's Thumbnail file property is a signed, time-limited S3 URL that
  // gets captured once here in `rows` - so download the images immediately,
  // before the YouTube/Facebook/Instagram/TikTok syncs below (which can run
  // for tens of minutes) have a chance to let those signed URLs expire.
  var thumbMap = {};
  try { thumbMap = await syncThumbnails(cfg, rows, path.join(DIST_DIR, 'thumbs')); } catch (e) { console.log('Thumbnail sync failed: ' + e); }

  var yt = await syncYouTube(cfg, rows);
  // Instagram has no duration field of its own (confirmed - Meta doesn't
  // expose one on the Media node) - reused from YouTube's here so its
  // avg-watch-% can still be computed, same video either way.
  var durationByPageId = {};
  yt.results.forEach(function (r) { if (typeof r.duration === 'number') durationByPageId[r.row.pageId] = r.duration; });
  var fb = fbEnabled ? await syncFacebook(cfg, rows) : null;
  var ig = fbEnabled ? await syncInstagram(cfg, rows, durationByPageId) : null;
  var tt = tiktokEnabled ? await syncTikTok(cfg, rows) : null;

  await writeUpdates(cfg, rows, yt, fb, ig, tt);

  // Long Form is a separate Notion database (Miradex only today), YouTube-only
  // (no Facebook/Instagram/TikTok fields exist on that schema) - reuses the
  // same fetch/sync/write functions above against an overridden config rather
  // than generalizing them, so this whole block is a no-op (and Isogreen's
  // pipeline is byte-for-byte unchanged) when the env var is unset.
  //
  // RETENTION_WINDOW_SECONDS is overridden to 30 here (vs. Shorts' default
  // 3): the "3s hook" checkpoint - and separately, YT Hook Rate's
  // engagedViews/views ratio - are both tuned around Shorts' swipe-away
  // behavior, where most drop-off happens in the opening couple of seconds.
  // A 10-56 minute video has a real intro (title card, "in this video…",
  // channel branding) - almost everyone who clicks is still watching at 3s,
  // so that number is close to 100% for every Long Form video and carries no
  // signal. 30s is past a typical intro and lines up with when actual
  // subject-matter drop-off starts to show on these videos' own retention
  // curves - written to its own "YT Retention @30s" property (not reusing
  // "YT Retention @3s") so the two windows are never conflated. Easy to
  // retune later via LONG_FORM env vars if 30s turns out wrong once more
  // data exists.
  if (cfg.LONG_FORM_NOTION_DATABASE_ID) {
    var lfCfg = Object.assign({}, cfg, {
      NOTION_DATABASE_ID: cfg.LONG_FORM_NOTION_DATABASE_ID,
      YT_FIELD_NAME: cfg.LONG_FORM_YT_FIELD_NAME,
      RETENTION_WINDOW_SECONDS: cfg.LONG_FORM_RETENTION_WINDOW_SECONDS,
      RETENTION_WINDOW_FIELD_NAME: cfg.LONG_FORM_RETENTION_FIELD_NAME,
      // Long Form rows have no "Text" property to disambiguate same-day
      // candidates during matching (see matchContent's comment in
      // notion.js) - without this, a same-day Short can get picked as a
      // false match via the date-only fallback (confirmed live: 3 rows had
      // silently matched to Shorts under a minute long). 60s is YouTube's
      // own rough Shorts/regular-video boundary.
      MIN_VIDEO_DURATION_SECONDS: 60,
      // Internal working titles ("Vizita fabrica Novatik") drift far from
      // what actually gets published - keep Notion's Name mirroring the
      // real YouTube title instead.
      SYNC_TITLE_FROM_YOUTUBE: true
    });
    try {
      var lfRows = await fetchNotionRows(lfCfg);
      var lfYt = await syncYouTube(lfCfg, lfRows);
      await writeUpdates(lfCfg, lfRows, lfYt, null, null, null);

      // Thumbnails: prefer Notion's own Thumbnail property (same as Shorts,
      // via syncThumbnails' existing precedence), falling back to the
      // video's public YouTube thumbnail for rows with none set. Unlike
      // Notion's signed file URLs, YouTube's thumbnail CDN URLs never expire,
      // so - unlike the main thumbMap above - there's no ordering constraint
      // forcing this to happen before the sync calls; running it here, after
      // the video is matched, is what makes the YouTube fallback possible at
      // all (needs the matched video ID). Merged into the same thumbMap/
      // thumbs dir the Shorts thumbnails use - Cods are unique across both
      // databases, so there's no key collision.
      var youtubeIdByPageId = {};
      lfYt.results.forEach(function (r) {
        var link = r.url || r.row.youtubeUrl;
        var id = link ? extractYouTubeId(link) : null;
        if (id) youtubeIdByPageId[r.row.pageId] = id;
      });
      try {
        var lfThumbMap = await syncThumbnails(lfCfg, lfRows, path.join(DIST_DIR, 'thumbs'), { youtubeIdByPageId: youtubeIdByPageId });
        Object.assign(thumbMap, lfThumbMap);
      } catch (e) { console.log('Long Form thumbnail sync failed: ' + e); }
    } catch (e) { console.log('Long Form sync failed: ' + e); }
  }

  try { await syncAudience(cfg); } catch (e) { console.log('Audience sync failed: ' + e); }

  var oldestDate = oldestPostDate(rows);

  try {
    await syncMonthlyViews(cfg, { fbEnabled: fbEnabled, ytEnabled: ytEnabled, oldestDate: oldestDate });
  } catch (e) { console.log('Monthly views sync failed: ' + e); }

  try {
    await syncDailyViews(cfg, { fbEnabled: fbEnabled, ytEnabled: ytEnabled });
  } catch (e) { console.log('Daily views sync failed: ' + e); }

  var dashboardData = null;
  try {
    dashboardData = await buildDashboard(cfg, thumbMap, DIST_DIR);
  } catch (e) { console.log('Dashboard build failed: ' + e); }

  // The reports app is one lightweight page embedding every month's data
  // plus a year/month picker - rendering happens entirely client-side when
  // a month is selected, so rebuilding it here (like the dashboard itself)
  // never overwrites anything a user is mid-edit on, since nothing is
  // pre-rendered or persisted per month.
  if (dashboardData) {
    try {
      await buildReportsApp(cfg, dashboardData, DIST_DIR);
    } catch (e) { console.log('Reports app build failed: ' + e); }
  }

  await writeSyncSummary({ yt: yt, fb: fb, ig: ig, tt: tt });
}

// This file is only ever invoked directly (npm run sync / GitHub Actions),
// never imported by another module, so it's safe to just run on load.
syncAllViews().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
