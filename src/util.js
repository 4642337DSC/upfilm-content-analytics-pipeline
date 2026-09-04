export const SYNC_TIMEZONE = 'Europe/Bucharest';

// Runs fn over items with at most `limit` in flight at once, preserving
// result order. The per-video/per-media API calls this backs (YouTube
// Analytics retention, Instagram insights, Notion page writes) have no
// batched equivalent, so they used to run one at a time in a for-loop -
// fine for a handful of rows, but tens of minutes of pure network latency
// once a client has a few hundred. Each call site still owns its own
// concurrency number so it can stay under that specific API's own rate
// limit rather than sharing one guess across very different services.
export async function mapWithConcurrency(items, limit, fn) {
  var results = new Array(items.length);
  var nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      var i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  var workers = [];
  for (var w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// Equivalent of Apps Script's Utilities.formatDate(d, SYNC_TIMEZONE, 'yyyy-MM-dd').
export function isoDate(d) {
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYNC_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  var map = {};
  parts.forEach(function (p) { map[p.type] = p.value; });
  return map.year + '-' + map.month + '-' + map.day;
}

export function dateKeyInTz(isoString) {
  return isoDate(new Date(isoString));
}

// Calendar months, oldest-to-newest, covering from startDate's month through
// the current (partial, still in progress) one. Each entry's start/end are
// UTC-midnight boundaries suitable for since/until unix timestamps. Used to
// pull the full available history rather than a fixed lookback window.
export function monthRangeSince(startDate) {
  var months = [];
  var cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  var now = new Date();
  var endCursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (cursor <= endCursor) {
    var start = new Date(cursor);
    var end = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    var key = start.getUTCFullYear() + '-' + ('0' + (start.getUTCMonth() + 1)).slice(-2);
    months.push({ start: start, end: end, key: key });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return months;
}
