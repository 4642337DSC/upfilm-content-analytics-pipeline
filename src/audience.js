import { fetchJson } from './http.js';
import { GRAPH_API_VERSION } from './config.js';
import { queryNotionDatabase, updateNotionPage, writeFollowerSnapshot, fetchFollowerSnapshots } from './notion.js';
import { resolveInstagramUserId } from './instagram.js';
import { fetchYouTubeFollowerHistoryForward } from './youtubeAnalytics.js';
import { isImplausibleFollowerCount, latestPreciseSnapshot, looksApiRounded } from './followerSanity.js';
import { isoDate } from './util.js';

// Don't reconstruct YouTube subscriber history forward across an unbounded
// gap - if the newest precise snapshot is more than this many days old,
// something is wrong upstream (backfill never ran, DB wiped) and a
// multi-hundred-day Analytics walk isn't the daily sync's job. Falls back
// to the Data API value in that case.
var MAX_YT_FORWARD_RECONSTRUCT_DAYS = 400;

// Account-level follower/subscriber counts (not per-video) - written to a
// separate small "Channel Stats" database, since the main Video database is
// keyed per-Short. Reuses the same platform credentials already configured
// elsewhere; skips silently per-platform if that platform isn't configured.
export async function syncAudience(cfg) {
  if (!cfg.CHANNEL_STATS_DATABASE_ID) return;
  var stats = {};
  // Extra daily snapshots to (re)write beyond today's single per-platform
  // row - currently just YouTube's forward reconstruction, which overwrites
  // any rounded Data API values already stored for those days.
  var extraSnapshots = [];

  try {
    var chData = await fetchJson(
      'https://www.googleapis.com/youtube/v3/channels?part=statistics&forHandle=' +
      encodeURIComponent(cfg.CHANNEL_HANDLE) + '&key=' + cfg.YOUTUBE_API_KEY);
    if (chData.items && chData.items.length) {
      var apiSubs = parseInt(chData.items[0].statistics.subscriberCount, 10);
      var totalViews = parseInt(chData.items[0].statistics.viewCount, 10);
      // The Data API rounds subscriberCount to 3 significant figures above
      // 1,000 subs. Prefer a precise count reconstructed from the Analytics
      // API's exact subscribersGained/Lost deltas, anchored on the newest
      // snapshot we already trust to be precise (see followerSanity.js).
      var ytFollowers = apiSubs;
      var ytOAuth = !!(cfg.YOUTUBE_OAUTH_CLIENT_ID && cfg.YOUTUBE_OAUTH_CLIENT_SECRET && cfg.YOUTUBE_REFRESH_TOKEN);
      if (ytOAuth && cfg.FOLLOWER_SNAPSHOTS_DATABASE_ID) {
        try {
          var series = await fetchFollowerSnapshots(cfg, 'YouTube');
          var anchor = latestPreciseSnapshot(series);
          if (anchor && daysBetween(anchor.date, isoDate(new Date())) <= MAX_YT_FORWARD_RECONSTRUCT_DAYS) {
            var forward = await fetchYouTubeFollowerHistoryForward(cfg, anchor.date, anchor.value, new Date());
            var forwardDays = Object.keys(forward).sort();
            if (forwardDays.length) {
              ytFollowers = forward[forwardDays[forwardDays.length - 1]];
              extraSnapshots = forwardDays.map(function (d) { return { platform: 'YouTube', date: d, followers: forward[d] }; });
            } else {
              // Anchor is already current (Analytics has no newer rows).
              ytFollowers = anchor.value;
            }
          } else if (!anchor && looksApiRounded(apiSubs)) {
            console.log('YouTube: no precise snapshot to anchor on and the Data API count is rounded - storing it as-is; run backfill:follower-history to seed a precise series.');
          }
        } catch (e) {
          console.log('YouTube precise subscriber reconstruction failed, using Data API value: ' + e);
        }
      }
      stats.YouTube = { followers: ytFollowers, totalViews: totalViews };
    }
  } catch (e) { console.log('YouTube audience fetch failed: ' + e); }

  if (cfg.FB_PAGE_ID && cfg.FB_PAGE_ACCESS_TOKEN) {
    try {
      var fbData = await fetchJson(
        'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + cfg.FB_PAGE_ID +
        '?fields=followers_count&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN);
      if (fbData.followers_count !== undefined) stats.Facebook = { followers: fbData.followers_count };
    } catch (e) { console.log('Facebook audience fetch failed: ' + e); }

    try {
      var igUserId = await resolveInstagramUserId(cfg);
      var igData = await fetchJson(
        'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + igUserId +
        '?fields=followers_count&access_token=' + cfg.FB_PAGE_ACCESS_TOKEN);
      if (igData.followers_count !== undefined) stats.Instagram = { followers: igData.followers_count };
    } catch (e) { console.log('Instagram audience fetch failed: ' + e); }
  }

  if (cfg.ZERNIO_API_KEY && cfg.ZERNIO_TIKTOK_ACCOUNT_ID) {
    try {
      var ttData = await fetchJson('https://zernio.com/api/v1/accounts', {
        headers: { Authorization: 'Bearer ' + cfg.ZERNIO_API_KEY }
      });
      var acct = (ttData.accounts || []).filter(function (a) { return a._id === cfg.ZERNIO_TIKTOK_ACCOUNT_ID; })[0];
      if (acct && acct.followersCount !== undefined) stats.TikTok = { followers: acct.followersCount };
    } catch (e) { console.log('TikTok audience fetch failed: ' + e); }
  }

  await writeAudienceStats(cfg, stats);

  if (cfg.FOLLOWER_SNAPSHOTS_DATABASE_ID) {
    var today = isoDate(new Date());
    for (var platform of Object.keys(stats)) {
      var followers = stats[platform].followers;
      // A non-positive count (the Zernio 0 seen on TikTok's first sync) or a
      // >25% single-day swing is an API glitch, not a real reading - writing
      // it poisons every month-over-month delta computed off it. Skip and
      // log rather than persist it.
      var prev = await latestSnapshotValue(cfg, platform);
      if (isImplausibleFollowerCount(followers, prev)) {
        console.log(platform + ' follower count ' + followers + ' looks implausible vs last snapshot ' + prev + ' - skipping snapshot.');
        continue;
      }
      try {
        await writeFollowerSnapshot(cfg, platform, today, followers);
      } catch (e) { console.log(platform + ' follower snapshot failed: ' + e); }
    }

    for (var snap of extraSnapshots) {
      if (isImplausibleFollowerCount(snap.followers, null)) continue;
      try {
        await writeFollowerSnapshot(cfg, snap.platform, snap.date, snap.followers);
      } catch (e) { console.log(snap.platform + ' reconstructed snapshot ' + snap.date + ' failed: ' + e); }
    }
  }
}

// Whole days between two "YYYY-MM-DD" strings (b - a), for the anchor-age check.
export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

async function latestSnapshotValue(cfg, platform) {
  try {
    var series = await fetchFollowerSnapshots(cfg, platform);
    return series.length ? series[series.length - 1].value : null;
  } catch (e) {
    return null;
  }
}

export async function writeAudienceStats(cfg, stats) {
  var data = await queryNotionDatabase(cfg, cfg.CHANNEL_STATS_DATABASE_ID, { page_size: 20 });
  if (data.object === 'error') { console.log('Channel Stats query failed: ' + data.message); return; }

  for (var page of (data.results || [])) {
    var platform = (page.properties['Platform'].title || []).map(function (t) { return t.plain_text; }).join('');
    var s = stats[platform];
    if (!s) continue;
    // Only "Platform" + "Followers" are guaranteed (the documented schema -
    // see Task 7 in the Miradex onboarding plan). "Updated At" and "Total
    // Channel Views" exist on Isogreen's database (created manually, ahead
    // of spec) but not necessarily on a new client's - Notion rejects a
    // PATCH atomically if ANY property in it doesn't exist on the target
    // database, which would silently drop the Followers write too. Only
    // include the optional ones when the queried page actually has them.
    var props = { 'Followers': { number: s.followers } };
    if (page.properties['Updated At']) props['Updated At'] = { date: { start: new Date().toISOString() } };
    if (s.totalViews !== undefined && page.properties['Total Channel Views']) {
      props['Total Channel Views'] = { number: s.totalViews };
    }
    await updateNotionPage(cfg, page.id, props);
  }
}
