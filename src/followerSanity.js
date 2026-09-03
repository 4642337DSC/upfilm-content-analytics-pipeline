// Guards for the Follower Snapshots pipeline. Two failure modes have been
// seen live, both of which wrote a "real"-looking number that then poisoned
// every month-over-month delta computed off it:
//
//   1. TikTok via Zernio returned followersCount: 0 on the account's first
//      sync (connected, but not yet populated on Zernio's side). Written as
//      a genuine snapshot, it became the earliest row on record - which the
//      monthly report uses as the delta baseline when there's no
//      previous-month-boundary snapshot, so August's "growth" came out as
//      the entire follower base (+22,172).
//
//   2. The YouTube Data API reports statistics.subscriberCount rounded to 3
//      significant figures once a channel passes 1,000 subscribers. Writing
//      that verbatim every day pins the series to a flat rounded value
//      (12,100 for a month straight), and comparing it against a precise
//      backfilled baseline (12,154) manufactures a phantom loss (-54).
//
// These helpers are pure so they can be unit-tested and reused by both the
// daily sync (src/audience.js) and the history backfill.

// Round to `sig` significant figures (default 3) the same way the YouTube
// Data API does. Exported for reuse/testing.
export function roundToSigFigs(value, sig) {
  sig = sig || 3;
  if (typeof value !== 'number' || !isFinite(value) || value === 0) return value;
  var digits = Math.ceil(Math.log10(Math.abs(value)));
  var power = sig - digits;
  var mag = Math.pow(10, power);
  return Math.round(value * mag) / mag;
}

// True when `value` could be a YouTube-Data-API-rounded subscriber count -
// i.e. it's >= 1,000 (below that the API is exact) and already equal to its
// own 3-significant-figure rounding. Used to avoid anchoring a precise
// reconstruction on a value we can't trust to be precise. A genuinely
// precise count that happens to land on a round number (e.g. exactly
// 12,000) is a false positive here; the caller just steps back one more
// snapshot, which costs at most one day's delta of accuracy.
export function looksApiRounded(value) {
  return typeof value === 'number' && isFinite(value) && value >= 1000 &&
    roundToSigFigs(value, 3) === value;
}

// True when `next` should NOT be written as a follower snapshot: missing,
// non-positive, or more than `maxFraction` (default 25%) away from the last
// known count. Real follower counts never move a quarter of the base
// between two daily captures - a swing that large is an API glitch (the
// Zernio 0, a transient partial response), not signal.
export function isImplausibleFollowerCount(next, prev, maxFraction) {
  maxFraction = typeof maxFraction === 'number' ? maxFraction : 0.25;
  if (typeof next !== 'number' || !isFinite(next) || next <= 0) return true;
  if (typeof prev === 'number' && isFinite(prev) && prev > 0) {
    if (Math.abs(next - prev) / prev > maxFraction) return true;
  }
  return false;
}

// From an ascending [{ date, value }] snapshot series, the most recent entry
// whose value is positive and not API-rounded - the newest point safe to
// anchor a precise forward reconstruction on. null when the series has no
// such entry (all rounded, all zero, or empty).
export function latestPreciseSnapshot(series) {
  if (!Array.isArray(series)) return null;
  for (var i = series.length - 1; i >= 0; i--) {
    var s = series[i];
    if (s && typeof s.value === 'number' && s.value > 0 && !looksApiRounded(s.value)) return s;
  }
  return null;
}
