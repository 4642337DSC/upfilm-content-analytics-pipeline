import { fetchJson } from './http.js';
import { matchContent, buildPlatformReport, findById, daysApart } from './notion.js';
import { fetchYouTubeVideoRetention, fetchYouTubeAvgWatchStats, fetchYouTubeImpressions, getYouTubeAccessToken } from './youtubeAnalytics.js';

// A cached "YouTube URL" is normally trusted unconditionally (that's the
// whole point of caching - skip re-matching every run). But a row's "Data
// Postare" can get rescheduled in Notion after the URL was first cached
// (or, rarely, the URL was mistyped by hand), and nothing was ever
// re-checking the cache against that - so a stale/wrong link would persist
// silently forever once written.
//
// Tolerance is deliberately generous (real videos routinely post several
// days later than their planned "Data Postare") - a stricter tolerance
// looked appealing but a domain-vocabulary text-similarity check was tried
// and rejected: on this narrow a topic (insulation/construction Shorts),
// bigram overlap between two *unrelated* videos' descriptions routinely
// scored above matchContent's own TEXT_MATCH_THRESHOLD just from shared
// generic terms, so it couldn't reliably tell a wrong match from a real
// one. A wide day gap (matches found empirically: legitimate late posts
// were 3-7 days off; an actual wrong link was 18 days off) is the only
// signal here that held up.
var CACHE_DATE_TOLERANCE_DAYS = 10;

function isCacheStillValid(row, cachedVideo) {
  if (!cachedVideo || !row.postDate) return true; // can't verify - keep trusting it
  return daysApart(row.postDate, cachedVideo.publishedAt) <= CACHE_DATE_TOLERANCE_DAYS;
}

export async function resolveUploadsPlaylistId(cfg) {
  var url = 'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=' +
    encodeURIComponent(cfg.CHANNEL_HANDLE) + '&key=' + cfg.YOUTUBE_API_KEY;
  var data = await fetchJson(url);
  if (!data.items || !data.items.length) {
    throw new Error('Could not resolve channel "' + cfg.CHANNEL_HANDLE + '": ' + JSON.stringify(data));
  }
  return data.items[0].contentDetails.relatedPlaylists.uploads;
}

export async function fetchAllYouTubeVideos(cfg) {
  var uploadsId = await resolveUploadsPlaylistId(cfg);
  var videos = [];
  var pageToken = '';
  do {
    var url = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=' +
      uploadsId + '&key=' + cfg.YOUTUBE_API_KEY + (pageToken ? '&pageToken=' + pageToken : '');
    var data = await fetchJson(url);
    (data.items || []).forEach(function (item) {
      var sn = item.snippet;
      if (!sn || !sn.resourceId) return;
      videos.push({
        id: sn.resourceId.videoId,
        text: sn.description || sn.title || '',
        title: sn.title || '',
        publishedAt: sn.publishedAt
      });
    });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return videos;
}

// PT1H2M3S -> 3723 (seconds). YouTube omits higher units entirely below
// their value (e.g. "PT45S" for a Short, no H/M) rather than zero-padding.
export function parseIso8601Duration(iso) {
  var m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso || '');
  if (!m) return null;
  var hours = m[1] ? parseInt(m[1], 10) : 0;
  var minutes = m[2] ? parseInt(m[2], 10) : 0;
  var seconds = m[3] ? parseFloat(m[3]) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

export async function fetchYouTubeViewCounts(cfg, videoIds) {
  var unique = videoIds.filter(function (id, i) { return videoIds.indexOf(id) === i; });
  var stats = {};
  for (var i = 0; i < unique.length; i += 50) {
    var batch = unique.slice(i, i + 50);
    var url = 'https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=' +
      batch.join(',') + '&key=' + cfg.YOUTUBE_API_KEY;
    var data = await fetchJson(url);
    (data.items || []).forEach(function (item) {
      stats[item.id] = {
        views: parseInt(item.statistics.viewCount, 10),
        duration: parseIso8601Duration(item.contentDetails && item.contentDetails.duration),
        likes: item.statistics.likeCount !== undefined ? parseInt(item.statistics.likeCount, 10) : null,
        comments: item.statistics.commentCount !== undefined ? parseInt(item.statistics.commentCount, 10) : null
      };
    });
  }
  return stats;
}

export function extractYouTubeId(url) {
  var m = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// A sample point plucked straight off the retention curve at ~windowSeconds
// in - NOT the same thing as "hook rate" (see fetchYouTubeAvgWatchStats for
// that, sourced from engagedViews instead - and see the comment on
// syncYouTube's `views/engagedViews` usage below for why that Shorts-shaped
// definition doesn't transfer to Long Form). This one inherits the retention
// curve's replay-inflation quirk and can read well above 100%, so it's
// labeled "Retention @Ns" rather than "Hook Rate" to avoid implying parity
// with Facebook/Instagram's capped, replay-free hook-rate numbers. Since
// the curve is bucketed by % of video elapsed rather than seconds, this
// converts windowSeconds into that video's own elapsed-ratio scale using its
// duration, then picks whichever bucket lands closest to it. Defaults to 3s
// (Shorts' own convention - unchanged behavior for every existing caller);
// Long Form's sync pass overrides this via cfg.RETENTION_WINDOW_SECONDS to
// a longer, more meaningful checkpoint for that content shape.
export function pickRetentionAtWindow(retention, duration, windowSeconds) {
  if (!retention || !duration) return null;
  var targetRatio = (windowSeconds || 3) / duration;
  var closestKey = null;
  var closestDiff = Infinity;
  Object.keys(retention).forEach(function (k) {
    var diff = Math.abs(parseFloat(k) - targetRatio);
    if (diff < closestDiff) { closestDiff = diff; closestKey = k; }
  });
  return closestKey === null ? null : Math.round(retention[closestKey] * 1000) / 10;
}

export async function syncYouTube(cfg, rows) {
  var videos = await fetchAllYouTubeVideos(cfg);
  var plan = [];
  var idsNeeded = [];

  rows.forEach(function (row) {
    if (row.youtubeUrl) {
      var cachedId = extractYouTubeId(row.youtubeUrl);
      if (cachedId && isCacheStillValid(row, findById(videos, cachedId))) {
        plan.push({ row: row, id: cachedId, isNewMatch: false, method: 'cached', score: null });
        idsNeeded.push(cachedId);
        return;
      }
    }
    var m = matchContent(row.postDate, row.text, videos);
    if (m) {
      plan.push({ row: row, id: m.id, isNewMatch: true, method: m.method, score: m.score });
      idsNeeded.push(m.id);
    }
  });

  var stats = await fetchYouTubeViewCounts(cfg, idsNeeded);

  // Retention/hook-rate/avg-watch all need the Analytics API (OAuth), not
  // the plain Data API key used for views/duration/likes/comments above -
  // guarded the same way sync.js gates Facebook/Instagram/TikTok on their
  // own credentials, so a client without OAuth configured still gets the
  // Data API v3 metrics rather than crashing the whole YouTube sync. Token
  // is minted once here and passed through, not re-minted per video - see
  // fetchYouTubeVideoRetention's comment.
  var ytAnalyticsEnabled = !!(cfg.YOUTUBE_OAUTH_CLIENT_ID && cfg.YOUTUBE_OAUTH_CLIENT_SECRET && cfg.YOUTUBE_REFRESH_TOKEN);
  var avgWatchStats = {};
  var impressionStats = {};
  var accessToken = null;
  if (ytAnalyticsEnabled) {
    accessToken = await getYouTubeAccessToken(cfg);
    avgWatchStats = await fetchYouTubeAvgWatchStats(accessToken, idsNeeded);
    impressionStats = await fetchYouTubeImpressions(accessToken, idsNeeded);
  }

  var results = [];
  for (var p of plan) {
    var stat = stats[p.id];
    if (stat === undefined) continue;
    var avgWatch = avgWatchStats[p.id] || {};
    var impressions = impressionStats[p.id] || {};
    // The one genuinely expensive call here (no batching available for
    // this dimension) - same cost pattern already accepted for Instagram's
    // per-media engagement fetch.
    var retentionData = ytAnalyticsEnabled ? await fetchYouTubeVideoRetention(accessToken, p.id) : null;
    // engagedViews is unreliable for anything posted before 2025-03-31 -
    // confirmed empirically the same way as Instagram's reels_skip_rate cutoff
    // (see instagram.js): consistently 75-100% (an implausible near-zero
    // swipe-away rate) through 2025-03-27, then a clean drop to a realistic
    // 28-58% range from 2025-03-31 on, no gradual transition. Reads as a
    // platform-side change in when/how engagedViews started being tracked
    // for Shorts, not anything wrong with these specific videos.
    var YT_HOOK_RATE_RELIABLE_FROM = '2025-03-31';
    var postDateReliable = !p.row.postDate || p.row.postDate >= YT_HOOK_RATE_RELIABLE_FROM;
    // Applies to cached matches too (not just fresh ones from the plan
    // above) - a cache entry can be a stale wrong-match from before this
    // guard existed (a Short that happened to land within matchContent's
    // date tolerance - Long Form rows have no "Text" property to
    // disambiguate against, see matchContent's comment), and re-verifying
    // duration here catches that on the very next sync, not just new
    // matches. Long Form's sync pass sets this to 60s; Shorts leaves it
    // unset (0), so this is a no-op for every existing caller.
    if (cfg.MIN_VIDEO_DURATION_SECONDS && stat.duration < cfg.MIN_VIDEO_DURATION_SECONDS) continue;
    var candidate = findById(videos, p.id);
    results.push({
      row: p.row, views: stat.views, duration: stat.duration, likes: stat.likes, comments: stat.comments,
      avgWatchTimeS: avgWatch.avgWatchTimeS, avgWatchPct: avgWatch.avgWatchPct,
      hookRate: postDateReliable ? avgWatch.hookRate : null,
      impressions: impressions.impressions, impressionsCtr: impressions.impressionsCtr,
      retentionAtWindow: retentionData ? pickRetentionAtWindow(retentionData.retention, stat.duration, cfg.RETENTION_WINDOW_SECONDS) : null,
      retention: retentionData ? retentionData.retention : null,
      relativeRetentionPerformance: retentionData ? retentionData.relativeRetentionPerformance : null,
      isNewMatch: p.isNewMatch, method: p.method, score: p.score,
      url: p.isNewMatch ? ('https://www.youtube.com/watch?v=' + p.id) : null,
      // Only ever populated when the candidate is still present in this
      // run's channel-upload fetch (always true for a fresh match; for a
      // long-cached match it could in principle be missing if the video's
      // publish date fell off fetchAllYouTubeVideos' page window, though in
      // practice the uploads playlist returns full history) - null rather
      // than a stale title is preferred when it can't be confirmed.
      youtubeTitle: candidate ? candidate.title : null
    });
  }

  return buildPlatformReport(rows, results);
}
