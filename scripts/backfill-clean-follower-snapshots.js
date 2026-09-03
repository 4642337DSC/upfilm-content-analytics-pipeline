import { getConfig } from '../src/config.js';
import { queryNotionDatabase, archiveNotionPage } from '../src/notion.js';

// One-time (safe to re-run) cleanup of bad rows in the Follower Snapshots
// database. Two kinds:
//
//   - Non-positive counts. TikTok via Zernio returned followersCount: 0 on
//     the account's first sync, before Zernio had populated it. Stored as a
//     real snapshot, it became the earliest row on record - which the
//     monthly report falls back to as the delta baseline when there's no
//     previous-month-boundary snapshot, so the month's "growth" came out as
//     the entire follower base. src/audience.js now refuses to write these
//     (see followerSanity.js); this removes the ones already stored.
//
//   - Optionally, YouTube rows equal to the Data API's 3-significant-figure
//     rounded value where a precise reconstruction exists on neighbouring
//     days. NOT archived by default - once src/audience.js runs with the
//     forward-reconstruction fix it overwrites those days in place with
//     precise values, so deleting them here would just create a gap the
//     next sync has to refill. Pass --drop-rounded-youtube only if you want
//     them gone immediately and accept the gap until the next sync.
//
// Archiving (not zeroing) matters because the dashboard's follower chart
// treats a missing day as a gap to leave blank but a stored value as a real
// measurement to plot - a false row has to disappear entirely.

var dropRoundedYouTube = process.argv.indexOf('--drop-rounded-youtube') !== -1;

var cfg = getConfig();
if (!cfg.NOTION_TOKEN) throw new Error('Set NOTION_TOKEN first.');
if (!cfg.FOLLOWER_SNAPSHOTS_DATABASE_ID) throw new Error('Set FOLLOWER_SNAPSHOTS_DATABASE_ID first.');

function roundToSigFigs(value, sig) {
  if (!value) return value;
  var digits = Math.ceil(Math.log10(Math.abs(value)));
  var mag = Math.pow(10, sig - digits);
  return Math.round(value * mag) / mag;
}

var archived = 0;
var cursor = null;
do {
  var payload = { page_size: 100 };
  if (cursor) payload.start_cursor = cursor;
  var data = await queryNotionDatabase(cfg, cfg.FOLLOWER_SNAPSHOTS_DATABASE_ID, payload);
  if (data.object === 'error') throw new Error('Follower Snapshots query failed: ' + data.message);
  for (var page of (data.results || [])) {
    var props = page.properties;
    var platform = props['Platform'] && props['Platform'].select ? props['Platform'].select.name : null;
    var date = props['Date'] && props['Date'].date ? props['Date'].date.start : null;
    var value = props['Followers'] ? props['Followers'].number : null;

    var isNonPositive = typeof value !== 'number' || value <= 0;
    var isRoundedYouTube = dropRoundedYouTube && platform === 'YouTube' &&
      typeof value === 'number' && value >= 1000 && roundToSigFigs(value, 3) === value;

    if (isNonPositive || isRoundedYouTube) {
      await archiveNotionPage(cfg, page.id);
      archived++;
      console.log('Archived ' + platform + ' ' + date + ' (Followers=' + value + ').');
    }
  }
  cursor = data.has_more ? data.next_cursor : null;
} while (cursor);

console.log('Follower Snapshots cleanup complete - archived ' + archived + ' row(s).');
