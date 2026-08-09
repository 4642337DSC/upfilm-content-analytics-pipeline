import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, requireConfig } from './config.js';
import { fetchNotionRows, writeUpdates } from './notion.js';
import { syncYouTube } from './youtube.js';
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
