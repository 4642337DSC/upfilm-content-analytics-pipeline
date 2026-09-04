import { fetchGraphJson } from './http.js';
import { GRAPH_API_VERSION } from './config.js';
import { matchContent, findById, buildPlatformReport } from './notion.js';
import { monthRangeSince, isoDate, mapWithConcurrency } from './util.js';

// Both insight fetches below are one call per media with no batched
// equivalent - comfortably under Meta's per-app rate limit while still
// cutting a few hundred sequential round-trips down substantially.
var INSTAGRAM_INSIGHT_CONCURRENCY = 6;

export async function resolveInstagramUserId(cfg) {
  var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + cfg.FB_PAGE_ID +
    '?fields=instagram_business_account&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
  var data = await fetchGraphJson(url);
  if (data.error) throw new Error('Could not resolve Instagram account: ' + JSON.stringify(data.error));
  if (!data.instagram_business_account) throw new Error('No Instagram Business/Creator account linked to this Facebook Page.');
  return data.instagram_business_account.id;
}

export async function fetchAllInstagramMedia(cfg) {
  var igUserId = await resolveInstagramUserId(cfg);
  var media = [];
  var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + igUserId + '/media' +
    '?fields=id,caption,timestamp,permalink,media_product_type,thumbnail_url,media_url' +
    '&limit=100&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
  while (url) {
    var data = await fetchGraphJson(url);
    if (data.error) throw new Error('Instagram media fetch failed: ' + JSON.stringify(data.error));
    (data.data || []).forEach(function (item) {
      if (item.media_product_type !== 'REELS' && item.media_product_type !== 'VIDEO') return;
      // thumbnail_url is the video's cover frame; media_url is a fallback
      // for media types where Meta doesn't expose a separate thumbnail.
      media.push({
        id: item.id, text: item.caption || '', publishedAt: item.timestamp, permalink: item.permalink || null,
        thumbnailUrl: item.thumbnail_url || item.media_url || null
      });
    });
    url = (data.paging && data.paging.next) ? data.paging.next : null;
  }
  return media;
}

export async function fetchInstagramInsight(cfg, mediaId, metric) {
  var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + mediaId +
    '/insights?metric=' + metric + '&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
  var data = await fetchGraphJson(url);
  return data.error ? null : data;
}

export async function fetchInstagramViewCounts(cfg, mediaIds) {
  var unique = mediaIds.filter(function (id, i) { return mediaIds.indexOf(id) === i; });
  var views = {};
  await mapWithConcurrency(unique, INSTAGRAM_INSIGHT_CONCURRENCY, async function (id) {
    var data = await fetchInstagramInsight(cfg, id, 'views');
    if (!data) data = await fetchInstagramInsight(cfg, id, 'plays'); // older API versions used "plays" for Reels
    if (data && data.data && data.data.length && data.data[0].values && data.data[0].values.length) {
      views[id] = data.data[0].values[0].value;
    }
  });
  return views;
}

// Engagement + hook-rate + watch-time metrics, one extra call per matched
// media (kept separate from fetchInstagramViewCounts rather than combined
// into it, since "views"/"plays" needs version-dependent fallback logic
// that could make a combined multi-metric request fail atomically for
// older media - these metrics are all stable across API versions, so a
// second simpler call is safer than risking the existing view-count path).
export async function fetchInstagramMediaMetrics(cfg, mediaIds) {
  var unique = mediaIds.filter(function (id, i) { return mediaIds.indexOf(id) === i; });
  var metrics = {};
  await mapWithConcurrency(unique, INSTAGRAM_INSIGHT_CONCURRENCY, async function (id) {
    var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + id +
      '/insights?metric=likes,comments,saved,shares,reels_skip_rate,ig_reels_avg_watch_time&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
    var data = await fetchGraphJson(url);
    if (data.error) { console.log('Instagram media metrics fetch failed for ' + id + ': ' + JSON.stringify(data.error)); return; }
    var m = {};
    (data.data || []).forEach(function (row) {
      m[row.name] = (row.values && row.values.length) ? row.values[0].value : null;
    });
    metrics[id] = m;
  });
  return metrics;
}

// durationByPageId is optional - { pageId: seconds }, sourced from
// syncYouTube's results (see sync.js) since Instagram exposes no duration
// field of its own. Without it, avgWatchPct just comes back null while
// avgWatchTimeS (a real, direct Instagram metric) still populates.
export async function syncInstagram(cfg, rows, durationByPageId) {
  var media = await fetchAllInstagramMedia(cfg);
  var matched = [];
  rows.forEach(function (row) {
    // A manually-pasted Instagram URL is trusted outright, no re-matching -
    // unlike every other signal here, this is a human override of the
    // auto-matcher, not something to second-guess. Needed because date+text
    // matching has no way to pick between two real, distinct posts with
    // identical captions (a same-day accidental double-post, confirmed
    // live) - matchContent correctly refuses to guess in that case, so a
    // human has to break the tie, and that choice needs to stick.
    if (row.instagramUrl) {
      var pinned = media.find(function (m) { return m.permalink === row.instagramUrl; });
      if (pinned) {
        matched.push({ row: row, id: pinned.id, method: 'manual-url', score: null });
        return;
      }
    }
    var m = matchContent(row.postDate, row.text, media);
    if (m) matched.push({ row: row, id: m.id, method: m.method, score: m.score });
  });

  var ids = matched.map(function (p) { return p.id; });
  var stats = await fetchInstagramViewCounts(cfg, ids);
  var extra = await fetchInstagramMediaMetrics(cfg, ids);

  var results = [];
  matched.forEach(function (p) {
    var views = stats[p.id];
    if (views === undefined) return;
    var candidate = findById(media, p.id);
    var m = extra[p.id] || {};
    var duration = durationByPageId ? durationByPageId[p.row.pageId] : undefined;
    // Hook rate framed as "% who kept watching" (matches Facebook's framing
    // and the user-facing label), so it's the inverse of the raw skip rate.
    //
    // reels_skip_rate is unreliable for anything posted before 2024-10-15 -
    // confirmed empirically across every Miradex row with a post date that
    // early: consistently 84-99.9% (implying a near-impossible 0-16% skip
    // rate) through 2024-10-11, then a clean drop to a realistic 30-70%
    // range from 2024-10-15 on, with no gradual transition between the two.
    // Reads as a platform-side methodology or data-availability change on
    // Meta's end for that metric specifically, not anything wrong with
    // these particular videos - blanked instead of stored, same reasoning
    // as the false-zero daily-views cleanup elsewhere in this pipeline.
    var IG_HOOK_RATE_RELIABLE_FROM = '2024-10-15';
    var postDateReliable = !p.row.postDate || p.row.postDate >= IG_HOOK_RATE_RELIABLE_FROM;
    var hookRate = (postDateReliable && typeof m.reels_skip_rate === 'number') ? Math.round((100 - m.reels_skip_rate) * 10) / 10 : null;
    var avgWatchTimeS = typeof m.ig_reels_avg_watch_time === 'number' ? Math.round(m.ig_reels_avg_watch_time) / 1000 : null;
    var avgWatchPct = (avgWatchTimeS !== null && duration) ? Math.round((avgWatchTimeS / duration) * 1000) / 10 : null;
    results.push({
      row: p.row, views: views, isNewMatch: true, method: p.method, score: p.score, url: candidate ? candidate.permalink : null,
      likes: typeof m.likes === 'number' ? m.likes : null,
      comments: typeof m.comments === 'number' ? m.comments : null,
      saves: typeof m.saved === 'number' ? m.saved : null,
      shares: typeof m.shares === 'number' ? m.shares : null,
      hookRate: hookRate, avgWatchTimeS: avgWatchTimeS, avgWatchPct: avgWatchPct
    });
  });
  return buildPlatformReport(rows, results);
}

// --- Instagram: account-level "views" metric - total_value only, capped at 30-day windows ---
// Reuses FB_PAGE_ACCESS_TOKEN (already used for the daily per-video sync and
// for follower counts). Meta's Graph API insists this metric use
// metric_type=total_value - it rejects a plain daily time series outright -
// AND caps since/until at 30 days apart even in total_value mode, which a
// 31-day calendar month exceeds by one day. So each calendar month is split
// into <=30-day sub-windows, each fetched as its own total_value aggregate,
// and the sub-window totals are summed to get the true month total
// (non-overlapping total_value windows can just be added).
export async function syncInstagramMonthly(cfg, oldestDate) {
  var igUserId = await resolveInstagramUserId(cfg);
  var monthly = {};
  var months = monthRangeSince(oldestDate);
  var now = new Date();

  for (var m of months) {
    var effectiveEnd = m.end > now ? now : m.end; // the current in-progress month's boundary is in the future - Meta rejects since/until beyond "now"
    if (effectiveEnd <= m.start) continue;
    var total = await fetchInstagramViewsTotalForRange(cfg, igUserId, m.start, effectiveEnd);
    if (total !== null) monthly[m.key] = total;
  }

  return monthly;
}

// Real per-day Instagram views, shape { "YYYY-MM-DD": views } - for
// src/dailyViews.js's Daily Views database. Unlike Facebook/YouTube,
// Instagram's "views" metric has no day-level time series mode at all (see
// the comment on syncInstagramMonthly above) - the only way to get a real
// number for a single day is to request that exact 1-day window in
// total_value mode. So this costs one API call per day requested, not one
// per month like the other platforms; callers should bound the range
// accordingly for anything run on a daily schedule (see dailyViews.js).
export async function fetchInstagramDailyViews(cfg, start, end) {
  var igUserId = await resolveInstagramUserId(cfg);
  var daily = {};
  var now = new Date();
  var effectiveEnd = end > now ? now : end;
  var dayStart = new Date(start);

  while (dayStart < effectiveEnd) {
    var dayEnd = new Date(Math.min(dayStart.getTime() + 24 * 60 * 60 * 1000, effectiveEnd.getTime()));
    var total = await fetchInstagramViewsTotalForRange(cfg, igUserId, dayStart, dayEnd);
    if (total !== null) daily[dayStart.toISOString().slice(0, 10)] = total;
    dayStart = dayEnd;
  }

  return daily;
}

// Current absolute follower count, for anchoring fetchInstagramDailyFollowers'
// delta reconstruction below.
export async function fetchInstagramCurrentFollowers(cfg) {
  var igUserId = await resolveInstagramUserId(cfg);
  var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + igUserId +
    '?fields=followers_count&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
  var data = await fetchGraphJson(url);
  if (data.error) throw new Error('Could not fetch current Instagram followers: ' + JSON.stringify(data.error));
  return data.followers_count;
}

// --- Instagram: account-level "follower_count" time-series insight ---
// Despite the name, this is NOT an absolute snapshot - it's the net change
// in followers *during* that day (confirmed empirically: treating it as a
// snapshot produced a history that was 0 on nearly every day, since a small
// account's day-to-day follower delta is usually 0 or a tiny number, not
// remotely close to the real total). Reconstructed the same way as
// fetchYouTubeDailyFollowers: collect each day's delta, then walk backwards
// from currentCount (today's real total, fetched by the caller via
// fetchInstagramCurrentFollowers).
//
// One call per <=30-day chunk. Each point's calendar day is derived from
// its POSITION in the series (chunkStart + i days), not from Meta's own
// end_time field - see fetchFacebookDayMetric's comment in facebook.js for
// why trusting end_time (even with a boundary offset correction) turned
// out to mislabel data by a full day. Used by
// scripts/backfill-follower-history.js. Errors are logged and skipped per
// chunk rather than thrown, in case some part of the history falls outside
// whatever retention window this metric turns out to have.
export async function fetchInstagramDailyFollowers(cfg, start, end, currentCount) {
  var igUserId = await resolveInstagramUserId(cfg);
  var deltaByDay = {};
  var MAX_CHUNK_MS = 30 * 24 * 60 * 60 * 1000;
  var chunkStart = new Date(start);

  while (chunkStart < end) {
    var chunkEnd = new Date(Math.min(chunkStart.getTime() + MAX_CHUNK_MS, end.getTime()));
    var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + igUserId +
      '/insights?metric=follower_count&period=day' +
      '&since=' + Math.floor(chunkStart.getTime() / 1000) +
      '&until=' + Math.floor(chunkEnd.getTime() / 1000) +
      '&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
    var data = await fetchGraphJson(url);
    if (data.error) {
      console.log('Instagram follower_count fetch failed for ' + isoDate(chunkStart) + '..' + isoDate(chunkEnd) + ': ' + JSON.stringify(data.error));
    } else {
      var series = (data.data && data.data.length) ? (data.data[0].values || []) : [];
      series.forEach(function (point, i) {
        if (typeof point.value !== 'number') return;
        var dateKey = new Date(chunkStart.getTime() + i * 86400000).toISOString().slice(0, 10);
        deltaByDay[dateKey] = point.value;
      });
    }
    chunkStart = chunkEnd;
  }

  var days = Object.keys(deltaByDay).sort();
  var daily = {};
  var running = currentCount;
  for (var i = days.length - 1; i >= 0; i--) {
    daily[days[i]] = running;
    running -= deltaByDay[days[i]];
  }
  return daily;
}

// Sums metric_type=total_value "views" over [start, end) by splitting into
// <=30-day sub-windows - Meta's hard cap for this metric+mode.
export async function fetchInstagramViewsTotalForRange(cfg, igUserId, start, end) {
  var MAX_CHUNK_MS = 30 * 24 * 60 * 60 * 1000;
  var total = 0;
  var gotAny = false;
  var chunkStart = new Date(start);

  while (chunkStart < end) {
    var chunkEnd = new Date(Math.min(chunkStart.getTime() + MAX_CHUNK_MS, end.getTime()));
    var url = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + igUserId +
      '/insights?metric=views&metric_type=total_value&period=day' +
      '&since=' + Math.floor(chunkStart.getTime() / 1000) +
      '&until=' + Math.floor(chunkEnd.getTime() / 1000) +
      '&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN;
    var data = await fetchGraphJson(url);
    if (data.error) {
      console.log('Instagram views fetch failed for ' + isoDate(chunkStart) + '..' + isoDate(chunkEnd) + ': ' + JSON.stringify(data.error));
    } else {
      var totalValue = (data.data && data.data.length && data.data[0].total_value) ? data.data[0].total_value.value : null;
      if (typeof totalValue === 'number') { total += totalValue; gotAny = true; }
    }
    chunkStart = chunkEnd;
  }

  return gotAny ? total : null;
}
