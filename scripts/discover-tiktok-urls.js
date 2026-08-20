import { getConfig, requireConfig } from '../src/config.js';
import { fetchNotionRows, matchContent, updateNotionPage } from '../src/notion.js';
import { fetchTikTokProfileVideos } from '../src/tiktokDiscovery.js';

// Fills in missing "TikTok URL" values by matching posted-but-unlinked rows
// against the account's public TikTok profile, using the same date+text
// scoring already trusted for Facebook/Instagram auto-matching (matchContent
// in notion.js). Stopgap until TikTok's own Login Kit + video.list replaces
// this (see PR discussion) - deliberately kept manual rather than folded
// into the daily sync:
//   - run it yourself, occasionally - not on a schedule, so it stays
//     infrequent and low-volume against TikTok's public profile page
//   - run it locally, not from CI - GitHub Actions' shared runner IPs are
//     far more likely to already be rate-limited/blocked by anti-bot
//     systems than a normal residential IP
//   - no login or cookies - only ever reads public data, same as opening
//     the profile in a browser signed out. Never touches the TikTok
//     account itself, so there's no ban risk to it.
//   - defaults to a dry run; nothing is written to Notion without --apply
//   - never overwrites a "TikTok URL" that's already filled in
//
// Usage:
//   npm run discover:tiktok            (dry run - prints what it would do)
//   npm run discover:tiktok -- --apply (writes the matches to Notion)
var cfg = getConfig();
requireConfig(cfg);
var apply = process.argv.includes('--apply');
var handle = cfg.TIKTOK_HANDLE || cfg.CHANNEL_HANDLE;

console.log('Fetching ' + handle + '\'s public TikTok profile via yt-dlp...');
var videos = await fetchTikTokProfileVideos(handle);
console.log('Found ' + videos.length + ' public TikTok videos.\n');

var rows = await fetchNotionRows(cfg);
var candidates = rows.filter(function (r) { return !r.tiktokUrl; });
console.log(candidates.length + ' posted row(s) have no TikTok URL yet.\n');

var matched = 0;
for (var row of candidates) {
  var m = matchContent(row.postDate, row.text, videos);
  if (!m) continue;
  var video = videos.filter(function (v) { return v.id === m.id; })[0];
  if (!video) continue;
  matched++;
  var scoreLabel = m.score === null || m.score === undefined ? 'unverified' : 'score ' + m.score.toFixed(2);
  console.log((apply ? '[WRITE] ' : '[DRY RUN] ') + row.cod + ' "' + row.name + '" -> ' + video.permalink +
    ' (' + m.method + ', ' + scoreLabel + ')');
  if (apply) {
    await updateNotionPage(cfg, row.pageId, { 'TikTok URL': { url: video.permalink } });
  }
}

console.log('\n' + matched + ' match(es) found' +
  (apply ? ', written to Notion.' : ' (dry run - re-run with --apply to write these).'));
if (!apply && matched) {
  console.log('Review the matches above before applying - date+text scoring can occasionally pick the wrong video.');
}
