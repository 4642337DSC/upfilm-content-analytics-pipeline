import { getConfig, requireConfig } from '../src/config.js';
import { fetchNotionRows, writeFollowerSnapshots, fetchFollowerSnapshots } from '../src/notion.js';
import { fetchJson } from '../src/http.js';
import { fetchYouTubeDailyFollowers, fetchYouTubeFollowerHistoryForward } from '../src/youtubeAnalytics.js';
import { latestPreciseSnapshot, looksApiRounded } from '../src/followerSanity.js';
import { fetchFacebookDailyFollowers } from '../src/facebook.js';
import { fetchInstagramDailyFollowers, fetchInstagramCurrentFollowers } from '../src/instagram.js';

// One-time full-history backfill for the Follower Snapshots database.
// Unlike view counts, none of these platforms expose a direct "follower
// count on day X" API - but each retains enough historical signal to
// reconstruct it:
//   - YouTube: no count-over-time metric, but subscribersGained/
//     subscribersLost day-level deltas are retained - reconstructed
//     backwards from today's real count (fetchYouTubeDailyFollowers).
//   - Facebook: page_follows is a real absolute-snapshot period=day time
//     series (same day-boundary handling as page_video_views).
//   - Instagram: follower_count IS a real period=day time series (unlike
//     "views", which only supports the total_value workaround) but despite
//     the name it's a daily DELTA, not an absolute snapshot - reconstructed
//     backwards the same way as YouTube.
//   - TikTok: Zernio (the only integration this pipeline has) exposes just
//     the current follower count, no history - not backfilled here. Daily
//     capture still continues going forward via the regular sync
//     (src/audience.js), same as before this script existed.
// Safe to re-run - every write is an upsert.
var cfg = getConfig();
requireConfig(cfg);
if (!cfg.FOLLOWER_SNAPSHOTS_DATABASE_ID) {
  throw new Error('Set FOLLOWER_SNAPSHOTS_DATABASE_ID first - run the create-follower-snapshots-db backfill script, or create it manually (see .env.example).');
}
var ytEnabled = !!(cfg.YOUTUBE_OAUTH_CLIENT_ID && cfg.YOUTUBE_OAUTH_CLIENT_SECRET && cfg.YOUTUBE_REFRESH_TOKEN);
var fbEnabled = !!(cfg.FB_PAGE_ID && cfg.FB_PAGE_ACCESS_TOKEN);

var rows = await fetchNotionRows(cfg);
var oldestDate = rows.reduce(function (oldest, r) {
  if (!r.postDate) return oldest;
  var d = new Date(r.postDate + 'T00:00:00Z');
  return (!oldest || d < oldest) ? d : oldest;
}, null) || new Date();
var start = new Date(Date.UTC(oldestDate.getUTCFullYear(), oldestDate.getUTCMonth(), oldestDate.getUTCDate()));
var end = new Date();

if (ytEnabled) {
  console.log('Fetching current YouTube subscriber count...');
  var chData = await fetchJson(
    'https://www.googleapis.com/youtube/v3/channels?part=statistics&forHandle=' +
    encodeURIComponent(cfg.CHANNEL_HANDLE) + '&key=' + cfg.YOUTUBE_API_KEY);
  var currentSubs = (chData.items && chData.items.length) ? parseInt(chData.items[0].statistics.subscriberCount, 10) : null;
  if (currentSubs === null) {
    console.log('Could not resolve current YouTube subscriber count - skipping YouTube.');
  } else {
    // The Data API rounds subscriberCount to 3 significant figures above
    // 1,000 subs, so anchoring the whole backward reconstruction on it bakes
    // a ~50-sub error into every historical day. If a precise snapshot
    // already exists (from an earlier run of this script), re-anchor: walk
    // the exact Analytics deltas FORWARD from it to get a precise
    // "current", then hand that to the backward reconstruction instead.
    var existing = latestPreciseSnapshot(await fetchFollowerSnapshots(cfg, 'YouTube'));
    if (existing) {
      try {
        var forward = await fetchYouTubeFollowerHistoryForward(cfg, existing.date, existing.value, end);
        var fwdDays = Object.keys(forward).sort();
        var preciseCurrent = fwdDays.length ? forward[fwdDays[fwdDays.length - 1]] : existing.value;
        console.log('Re-anchoring on precise snapshot ' + existing.date + ' (' + existing.value + ') -> precise current ' + preciseCurrent + ' (Data API rounded: ' + currentSubs + ').');
        currentSubs = preciseCurrent;
      } catch (e) {
        console.log('Forward re-anchor failed, using Data API count: ' + e);
      }
    } else if (looksApiRounded(currentSubs)) {
      console.log('No precise YouTube snapshot to re-anchor on - reconstruction will carry the Data API\'s ~3-sig-fig rounding (' + currentSubs + '). Re-run once a precise series exists to tighten it.');
    }
    console.log('Reconstructing YouTube daily subscriber history from ' + currentSubs + ' current subscribers...');
    var ytDaily = await fetchYouTubeDailyFollowers(cfg, start, end, currentSubs);
    console.log('Writing ' + Object.keys(ytDaily).length + ' YouTube day(s)...');
    await writeFollowerSnapshots(cfg, 'YouTube', ytDaily);
  }
} else {
  console.log('YouTube OAuth not configured - skipping.');
}

if (fbEnabled) {
  console.log('Fetching Facebook daily follower history...');
  var fbDaily = await fetchFacebookDailyFollowers(cfg, start, end);
  console.log('Writing ' + Object.keys(fbDaily).length + ' Facebook day(s)...');
  await writeFollowerSnapshots(cfg, 'Facebook', fbDaily);

  console.log('Fetching current Instagram follower count...');
  var currentIgFollowers = await fetchInstagramCurrentFollowers(cfg);
  console.log('Reconstructing Instagram daily follower history from ' + currentIgFollowers + ' current followers...');
  var igDaily = await fetchInstagramDailyFollowers(cfg, start, end, currentIgFollowers);
  console.log('Writing ' + Object.keys(igDaily).length + ' Instagram day(s)...');
  await writeFollowerSnapshots(cfg, 'Instagram', igDaily);
} else {
  console.log('FB_PAGE_ID/FB_PAGE_ACCESS_TOKEN not configured - skipping Facebook + Instagram.');
}

console.log('TikTok has no historical follower API available via Zernio - not backfilled; daily capture continues going forward.');
console.log('Follower history backfill complete.');
