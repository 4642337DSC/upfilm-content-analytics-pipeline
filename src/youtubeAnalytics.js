import { fetchJson } from './http.js';
import { isoDate } from './util.js';

// YouTube Analytics needs an OAuth *user* token scoped to the channel owner -
// the plain API key used elsewhere in youtube.js can't reach it. The token is
// minted once locally via scripts/youtube-oauth-setup.js; only the resulting
// refresh token is stored (as a GitHub secret), exchanged here for a
// short-lived access token on every run.
export async function getYouTubeAccessToken(cfg) {
  var data = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.YOUTUBE_OAUTH_CLIENT_ID,
      client_secret: cfg.YOUTUBE_OAUTH_CLIENT_SECRET,
      refresh_token: cfg.YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }).toString()
  });
  if (!data.access_token) throw new Error('YouTube OAuth token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

// Channel-level "views" by exact calendar day, [start, end] inclusive -
// shape { "YYYY-MM-DD": views }. Used by both syncYouTubeMonthly (buckets
// this into months for the Monthly Views database, full history every run)
// and src/dailyViews.js (writes it as-is to the Daily Views database, a
// bounded recent window every run) - each calls this with its own range,
// which is fine since the API call itself is cheap regardless of span.
//
// Note: YouTube Analytics has its own ~2-3 day processing lag (confirmed by
// requesting through "today" and getting no rows for the last few days) -
// unlike Meta's Graph API, which is close to real-time. So the last couple
// of days may legitimately be missing; they appear once YouTube catches up.
export async function fetchYouTubeDailyViews(cfg, start, end) {
  var accessToken = await getYouTubeAccessToken(cfg);

  var url = 'https://youtubeanalytics.googleapis.com/v2/reports?' + new URLSearchParams({
    ids: 'channel==MINE',
    metrics: 'views',
    dimensions: 'day',
    sort: 'day',
    startDate: isoDate(start),
    endDate: isoDate(end)
  }).toString();

  var data = await fetchJson(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (data.error) throw new Error('YouTube Analytics fetch failed: ' + JSON.stringify(data.error));

  var daily = {};
  (data.rows || []).forEach(function (row) { daily[String(row[0])] = row[1]; });
  return daily;
}

// Full daily subscriber-count history, reconstructed rather than fetched
// directly - the Analytics API has no "subscriber count over time" metric,
// but does retain subscribersGained/subscribersLost day-level deltas back
// through the channel's history. Anchored to currentCount (today's real
// count, from the Data API's plain statistics.subscriberCount, fetched by
// the caller) and walked backwards day by day.
export async function fetchYouTubeDailyFollowers(cfg, start, end, currentCount) {
  var accessToken = await getYouTubeAccessToken(cfg);

  var url = 'https://youtubeanalytics.googleapis.com/v2/reports?' + new URLSearchParams({
    ids: 'channel==MINE',
    metrics: 'subscribersGained,subscribersLost',
    dimensions: 'day',
    sort: 'day',
    startDate: isoDate(start),
    endDate: isoDate(end)
  }).toString();

  var data = await fetchJson(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (data.error) throw new Error('YouTube subscriber history fetch failed: ' + JSON.stringify(data.error));

  var deltaByDay = {};
  (data.rows || []).forEach(function (row) { deltaByDay[String(row[0])] = row[1] - row[2]; });

  var days = Object.keys(deltaByDay).sort();
  var daily = {};
  var running = currentCount;
  for (var i = days.length - 1; i >= 0; i--) {
    daily[days[i]] = running;
    running -= deltaByDay[days[i]];
  }
  return daily;
}

// Per-video audience retention curve, plus how it compares to similar-
// length YouTube videos - both come from the same "elapsedVideoTimeRatio"
// dimension, one call per video (this dimension can't batch across videos
// the way "video" dimension can below) - same cost pattern as Instagram's
// per-media engagement call. Buckets are % of video elapsed (0.01-1.00,
// ~100 points), NOT seconds like Facebook's post_video_retention_graph -
// see syncYouTube's hook-rate calc for how the two get reconciled onto a
// shared axis using the video's own duration.
//
// audienceWatchRatio can legitimately exceed 1 at points viewers rewind to
// replay (most often the very start) - a real YouTube Studio behavior, not
// a bug - kept as-is rather than clamped so the popup can show it honestly.
//
// Empty rows are a real, common case for very recently published videos -
// same ~2-3 day processing lag as fetchYouTubeDailyViews - not an error,
// just nothing to report yet.
//
// Takes an already-minted accessToken (not cfg) - the caller loops this
// once per matched video (up to a few hundred per sync), and re-running
// the OAuth token refresh handshake that many times was pure waste (plus
// needless load on Google's token endpoint) when one token comfortably
// covers a whole sync run.
export async function fetchYouTubeVideoRetention(accessToken, videoId) {
  var url = 'https://youtubeanalytics.googleapis.com/v2/reports?' + new URLSearchParams({
    ids: 'channel==MINE',
    metrics: 'audienceWatchRatio,relativeRetentionPerformance',
    dimensions: 'elapsedVideoTimeRatio',
    filters: 'video==' + videoId,
    startDate: '2020-01-01',
    endDate: isoDate(new Date())
  }).toString();
  var data = await fetchJson(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (data.error) { console.log('YouTube retention fetch failed for ' + videoId + ': ' + JSON.stringify(data.error)); return null; }
  if (!data.rows || !data.rows.length) return null;

  // Rounded to 4 decimals - the raw API values carry ~16 significant
  // digits of float noise, which at ~100 buckets would risk exceeding
  // Notion's 2000-character rich_text limit once JSON-stringified (see
  // notion.js's YT Retention Graph write) for no real precision benefit.
  var retention = {};
  var relPerf = [];
  data.rows.forEach(function (row) {
    retention[row[0]] = Math.round(row[1] * 10000) / 10000;
    if (typeof row[2] === 'number') relPerf.push(row[2]);
  });
  var avgRelPerf = relPerf.length ? relPerf.reduce(function (a, b) { return a + b; }, 0) / relPerf.length : null;
  return { retention: retention, relativeRetentionPerformance: avgRelPerf };
}

// Avg watch duration (seconds) + avg % of video watched + engagedViews,
// batched across many videos per call via dimensions=video with a comma-
// separated filter - much cheaper than the per-video retention call above.
// Batch size matches fetchYouTubeViewCounts' Data API v3 batching (50) for
// consistency, though this endpoint isn't confirmed to share that exact
// limit. Takes an already-minted accessToken - see
// fetchYouTubeVideoRetention's comment.
//
// engagedViews is a real, separate metric (confirmed live) - Studio's
// "hook rate" for Shorts is engagedViews/views, i.e. the inverse of
// "swiped away %", which has no metric of its own but doesn't need one
// once engagedViews is available. This is framed the same way as
// Facebook/Instagram's hook rate (a plain 0-100% "did they stay" number) -
// unlike the replay-inflated audienceWatchRatio-based figure from the
// retention curve, which is kept separately (see pickRetentionAt3s in
// youtube.js, labeled "Retention @3s" rather than "Hook Rate" to avoid
// implying the two are the same measurement).
export async function fetchYouTubeAvgWatchStats(accessToken, videoIds) {
  var unique = videoIds.filter(function (id, i) { return videoIds.indexOf(id) === i; });
  var stats = {};
  for (var i = 0; i < unique.length; i += 50) {
    var batch = unique.slice(i, i + 50);
    var url = 'https://youtubeanalytics.googleapis.com/v2/reports?' + new URLSearchParams({
      ids: 'channel==MINE',
      metrics: 'views,averageViewDuration,averageViewPercentage,engagedViews',
      dimensions: 'video',
      filters: 'video==' + batch.join(','),
      startDate: '2020-01-01',
      endDate: isoDate(new Date())
    }).toString();
    var data = await fetchJson(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (data.error) { console.log('YouTube avg watch stats fetch failed: ' + JSON.stringify(data.error)); continue; }
    (data.rows || []).forEach(function (row) {
      var views = row[1], engagedViews = row[4];
      stats[row[0]] = {
        avgWatchTimeS: row[2], avgWatchPct: row[3],
        hookRate: (typeof views === 'number' && views > 0 && typeof engagedViews === 'number')
          ? Math.round((engagedViews / views) * 1000) / 10 : null
      };
    });
  }
  return stats;
}

// Buckets fetchYouTubeDailyViews into calendar months, since oldestDate's
// month through the current (partial) one - same shape as
// syncInstagramMonthly/syncFacebookMonthly so it drops straight into
// writeMonthlyViews.
//
// dimensions=month itself turned out to be unusable: the Analytics API
// insists both startDate/endDate "align" to a month boundary, but a month's
// last day AND a bare first-of-month endDate both got rejected or silently
// truncated the range - the latter meant the current in-progress month
// never got queried at all. Bucketing day-level data ourselves sidesteps
// the whole alignment quirk and naturally includes today's partial month.
export async function syncYouTubeMonthly(cfg, oldestDate) {
  var start = new Date(Date.UTC(oldestDate.getUTCFullYear(), oldestDate.getUTCMonth(), 1));
  var daily = await fetchYouTubeDailyViews(cfg, start, new Date());

  var monthly = {};
  Object.keys(daily).forEach(function (dateKey) {
    var monthKey = dateKey.slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"
    monthly[monthKey] = (monthly[monthKey] || 0) + daily[dateKey];
  });
  return monthly;
}
