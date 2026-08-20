import { fetchText } from './http.js';
import { buildPlatformReport } from './notion.js';

// TikTok has no listing API for pre-existing posts (Zernio's /posts edge only
// tracks content posted through Zernio itself), so there's no date+text
// auto-matching here - each row needs its "TikTok URL" pasted in manually
// once, and the script just re-fetches that video's view count every run.
export function extractTikTokId(url) {
  var m = url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

// likes/comments/shares/saves all arrive in this same response Zernio
// already sends for views - no extra API call for any of them. Duration
// and watch-time were checked too (see analytics.videoDurationSeconds) but
// come back null for externally-synced posts - not available in practice.
export async function fetchTikTokAnalytics(cfg, videoId) {
  var url = 'https://zernio.com/api/v1/analytics?postId=' + videoId + '&accountId=' + cfg.ZERNIO_TIKTOK_ACCOUNT_ID;
  var res = await fetchText(url, { headers: { Authorization: 'Bearer ' + cfg.ZERNIO_API_KEY } });
  var data;
  try { data = res.json(); } catch (e) {
    console.log('Zernio analytics: non-JSON response for postId ' + videoId + ' (status ' + res.status + '): ' + res.text.slice(0, 500));
    return null;
  }
  if (!data.analytics || typeof data.analytics.views !== 'number') {
    // Was silently swallowed before - a single video (24-S23) fails every
    // run while every other row with a URL succeeds, and there's no way to
    // tell why without seeing Zernio's actual response body.
    console.log('Zernio analytics: no usable data for postId ' + videoId + ' (status ' + res.status + '): ' + res.text.slice(0, 500));
    return null;
  }
  var a = data.analytics;
  return {
    views: a.views,
    likes: typeof a.likes === 'number' ? a.likes : null,
    comments: typeof a.comments === 'number' ? a.comments : null,
    shares: typeof a.shares === 'number' ? a.shares : null,
    saves: typeof a.saves === 'number' ? a.saves : null
  };
}

export async function syncTikTok(cfg, rows) {
  var results = [];
  for (var row of rows) {
    if (!row.tiktokUrl) continue;
    var videoId = extractTikTokId(row.tiktokUrl);
    if (!videoId) continue;
    var stats = await fetchTikTokAnalytics(cfg, videoId);
    if (!stats) continue;
    results.push({
      row: row, views: stats.views, isNewMatch: false, method: 'manual-url', score: null, url: null,
      likes: stats.likes, comments: stats.comments, shares: stats.shares, saves: stats.saves
    });
  }
  return buildPlatformReport(rows, results);
}
