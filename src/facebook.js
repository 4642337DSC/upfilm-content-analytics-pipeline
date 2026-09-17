import { fetchGraphJson } from './http.js';
import { GRAPH_API_VERSION } from './config.js';
import { matchContent, findById, buildPlatformReport } from './notion.js';
import { mapWithConcurrency } from './util.js';

// Isogreen's Shorts are posted as Facebook Reels, which live under /video_reels
// (not the legacy /videos edge) and use the "blue_reels_play_count" metric
// instead of "total_video_views". Also requires a Page-scoped access token,
// not a User token, per Meta's "new Pages experience".
//
// Kept deliberately light - just enough to date+text match a row against a
// candidate. Insights (views/likes/retention) used to be fetched inline here
// via field expansion, but that made every page of this listing carry a full
// per-second retention curve for up to 100 videos at once - as the channel's
// history grew past a couple hundred Reels, Meta started rejecting the
// request outright with code 1 "Please reduce the amount of data you're
// asking for" on every single sync run (confirmed live on both Isogreen and
// Miradex - fetchGraphJson's retry-on-code-1 didn't help, since re-sending
// the identical oversized request just gets the identical rejection).
// http.js's TRANSIENT_META_ERROR_CODES treats code 1 as retryable because
// it's normally Meta's flaky "unknown error" catch-all - it isn't flaky here,
// it's a deterministic complexity-budget rejection, and fetchAllFacebookVideos
// throwing on it killed the *entire* Facebook sync (zero views/URLs written
// for any video, every platform-field on every row silently staying stale)
// rather than just one page. Insights are now fetched separately, per
// matched video only (see fetchFacebookVideoInsights below) - mirrors how
// instagram.js already splits fetchAllInstagramMedia (light) from
// fetchInstagramViewCounts/fetchInstagramMediaMetrics (insights, per-id).
var FB_VIDEO_LIST_FIELDS = 'id,description,created_time,permalink_url,picture,length';

// Engagement/watch-time fields, fetched one call per matched video (not
// per row in the bulk listing) - see FB_VIDEO_LIST_FIELDS' comment for why.
// "comments" and "shares" were tried too and don't exist on the Reels object
// at all (confirmed live - "Tried accessing nonexisting field" even
// permission aside), unlike "likes" which does.
var FB_VIDEO_INSIGHTS_FIELDS = 'likes.summary(true),' +
  'video_insights.metric(blue_reels_play_count,post_video_avg_time_watched,post_video_retention_graph)';

function parseFacebookVideoListItem(item) {
  var length = typeof item.length === 'number' ? item.length : null;
  var permalink = item.permalink_url
    ? (item.permalink_url.indexOf('http') === 0 ? item.permalink_url : 'https://www.facebook.com' + item.permalink_url)
    : null;
  return { id: item.id, text: item.description || '', publishedAt: item.created_time, permalink: permalink, length: length, picture: item.picture || null };
}

// `length` comes from the caller's already-fetched list item (or null when
// a manual-URL id wasn't found in the light listing at all).
function parseFacebookInsights(item, length) {
  var insights = {};
  if (item.video_insights && item.video_insights.data) {
    item.video_insights.data.forEach(function (m) {
      insights[m.name] = (m.values && m.values.length) ? m.values[0].value : null;
    });
  }
  var views = insights.blue_reels_play_count !== undefined ? insights.blue_reels_play_count : null;
  var avgWatchMs = typeof insights.post_video_avg_time_watched === 'number' ? insights.post_video_avg_time_watched : null;
  var retention = insights.post_video_retention_graph || null;
  // Hook rate: retention[6] IS already "fraction of the audience still
  // watching at second 6" - exactly "kept watching past the hook
  // window" (6s for Facebook, since its retention data plateaus
  // through ~3s - see the flat-start explanation elsewhere).
  var hookRate = (retention && retention['6'] !== undefined) ? Math.round(retention['6'] * 1000) / 10 : null;
  var avgWatchPct = (avgWatchMs !== null && length) ? Math.round((avgWatchMs / 1000 / length) * 1000) / 10 : null;
  return {
    views: views,
    likes: (item.likes && item.likes.summary) ? item.likes.summary.total_count : null,
    avgWatchTimeS: avgWatchMs !== null ? Math.round(avgWatchMs) / 1000 : null,
    avgWatchPct: avgWatchPct, hookRate: hookRate, retention: retention
  };
}

// One call per matched video - not one per row in bulk, see
// FB_VIDEO_LIST_FIELDS' comment above for why.
var FB_INSIGHTS_CONCURRENCY = 6;

export async function fetchFacebookVideoInsights(cfg, videoId, length) {
  var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + videoId +
    '?fields=' + FB_VIDEO_INSIGHTS_FIELDS + '&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
  var data = await fetchGraphJson(url);
  if (data.error) return null;
  return parseFacebookInsights(data, length);
}

export async function fetchAllFacebookVideos(cfg) {
  var videos = [];
  var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + cfg.FB_PAGE_ID + '/video_reels' +
    '?fields=' + FB_VIDEO_LIST_FIELDS + '&limit=100&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
  while (url) {
    var data = await fetchGraphJson(url);
    if (data.error) throw new Error('Facebook videos fetch failed: ' + JSON.stringify(data.error));
    (data.data || []).forEach(function (item) { videos.push(parseFacebookVideoListItem(item)); });
    url = (data.paging && data.paging.next) ? data.paging.next : null;
  }
  return videos;
}

// Facebook reel/video URLs (facebook.com/reel/<id> or the legacy
// .../videos/<id>) embed the real Graph API object ID directly, unlike
// Instagram permalink shortcodes - so a saved "Facebook URL" can be looked
// up with a single direct GET, no bulk listing required.
export function extractFacebookVideoId(url) {
  if (!url) return null;
  var m = url.match(/\/(?:reel|videos)\/(\d+)/);
  return m ? m[1] : null;
}

export async function syncFacebook(cfg, rows) {
  var videos = await fetchAllFacebookVideos(cfg); // light listing only - see FB_VIDEO_LIST_FIELDS' comment for why
  var results = [];

  await mapWithConcurrency(rows, FB_INSIGHTS_CONCURRENCY, async function (row) {
    var candidate = null, method = null, score = null;
    var m = matchContent(row.postDate, row.text, videos);
    if (m) {
      candidate = findById(videos, m.id);
      method = m.method;
      score = m.score;
    }

    var insights = candidate ? await fetchFacebookVideoInsights(cfg, candidate.id, candidate.length) : null;

    // A manually-pasted/cached Facebook URL is trusted as a fallback when
    // date+text matching found nothing, or found a candidate with no usable
    // views - same reasoning as Instagram's manual-url path, except this
    // can go straight to a direct by-ID fetch instead of only searching
    // within the bulk listing, since a Facebook URL's ID is real and
    // fetchable on its own even when /video_reels never surfaces the item
    // (confirmed live for at least one Instagram-crossposted Reel).
    if ((!insights || insights.views === null || insights.views === undefined) && row.facebookUrl) {
      var savedId = extractFacebookVideoId(row.facebookUrl);
      if (savedId) {
        var pinnedListItem = findById(videos, savedId);
        var pinnedInsights = await fetchFacebookVideoInsights(cfg, savedId, pinnedListItem ? pinnedListItem.length : null);
        if (pinnedInsights && pinnedInsights.views !== null && pinnedInsights.views !== undefined) {
          candidate = pinnedListItem || { id: savedId, permalink: row.facebookUrl };
          insights = pinnedInsights;
          method = 'manual-url';
          score = null;
        }
      }
    }

    if (!insights || insights.views === null || insights.views === undefined) return;
    results.push({
      row: row, views: insights.views, isNewMatch: true, method: method, score: score, url: candidate.permalink,
      likes: insights.likes, hookRate: insights.hookRate, avgWatchPct: insights.avgWatchPct,
      avgWatchTimeS: insights.avgWatchTimeS, retention: insights.retention
    });
  });

  return buildPlatformReport(rows, results);
}

// Shared chunked period=day fetcher for any Facebook Page insight metric.
// Chunked into <=30-day windows since Meta caps since/until at that span.
// mode "sum": additive metrics (views) - multiple points for the same day
// (shouldn't normally happen given non-overlapping chunks, but just in
// case) get added together. mode "last": snapshot metrics (follower
// counts) - a later value overwrites rather than adds.
//
// Each point's calendar day is derived from its POSITION in the series
// (chunkStart + i days), not from Meta's own end_time field. A first
// attempt trusted end_time (treating it as the exclusive end-of-day
// boundary and stepping back 1 second) but that still mislabeled every
// day's data as the following day - Meta's actual day-boundary convention
// for this Page isn't reliably UTC midnight, so a fixed small offset
// wasn't enough to reliably land back in the correct day. since/until are
// UTC timestamps we chose ourselves, and period=day always returns one
// point per day in chronological order starting at chunkStart, so position
// is a source of truth end_time isn't.
async function fetchFacebookDayMetric(cfg, metric, start, end, mode) {
  var daily = {};
  var chunkEnd = new Date(end);

  while (chunkEnd > start) {
    var chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() - 30);
    if (chunkStart < start) chunkStart = new Date(start);

    var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + cfg.FB_PAGE_ID +
      '/insights/' + metric + '?period=day' +
      '&since=' + Math.floor(chunkStart.getTime() / 1000) +
      '&until=' + Math.floor(chunkEnd.getTime() / 1000) +
      '&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
    var data = await fetchGraphJson(url);
    if (data.error) throw new Error('Facebook ' + metric + ' fetch failed: ' + JSON.stringify(data.error));

    var series = (data.data && data.data.length) ? (data.data[0].values || []) : [];
    series.forEach(function (point, i) {
      if (typeof point.value !== 'number') return;
      var dateKey = new Date(chunkStart.getTime() + i * 86400000).toISOString().slice(0, 10);
      daily[dateKey] = mode === 'sum' ? (daily[dateKey] || 0) + point.value : point.value;
    });

    chunkEnd = new Date(chunkStart.getTime() - 1000);
  }

  return daily;
}

// --- Facebook: Page-level "page_video_views" time-series insight ---
// Covers all Page video content (Reels included, but not Reels-exclusive -
// Meta has no Reels-only equivalent at the Page level). Returns exact
// per-day values (shape { "YYYY-MM-DD": views }), used both to bucket into
// months (syncFacebookMonthly, for the Monthly Views database) and as-is by
// src/dailyViews.js (for the Daily Views database).
export async function fetchFacebookDailyViews(cfg, start, end) {
  return fetchFacebookDayMetric(cfg, 'page_video_views', start, end, 'sum');
}

// --- Facebook: Page-level "page_follows" time-series insight ---
// Total Page follower count as of each day - a real day-by-day history,
// not just a snapshot from whenever tracking started. "page_fans" (the
// older "Page Likes" metric name) is rejected outright by the API for this
// Page - "(#100) The value must be a valid insights metric" - since Meta's
// "new Pages experience" (already required elsewhere in this file for the
// Page-scoped access token) replaced Likes with Followers and renamed the
// underlying metric to match. Used by scripts/backfill-follower-history.js.
export async function fetchFacebookDailyFollowers(cfg, start, end) {
  return fetchFacebookDayMetric(cfg, 'page_follows', start, end, 'last');
}

export async function syncFacebookMonthly(cfg, oldestDate) {
  var oldestNeeded = new Date(Date.UTC(oldestDate.getUTCFullYear(), oldestDate.getUTCMonth(), 1));
  var daily = await fetchFacebookDailyViews(cfg, oldestNeeded, new Date());

  var monthly = {};
  Object.keys(daily).forEach(function (dateKey) {
    var monthKey = dateKey.slice(0, 7);
    monthly[monthKey] = (monthly[monthKey] || 0) + daily[dateKey];
  });
  return monthly;
}
