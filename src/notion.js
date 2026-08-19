import { fetchJson } from './http.js';
import { NOTION_VERSION, TEXT_MATCH_THRESHOLD, TEXT_MARGIN } from './config.js';
import { dateKeyInTz } from './util.js';

function notionHeaders(cfg) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + cfg.NOTION_TOKEN,
    'Notion-Version': NOTION_VERSION
  };
}

export async function fetchNotionRows(cfg, tipValue) {
  var rows = [];
  var cursor = null;
  do {
    var payload = {
      page_size: 100,
      filter: buildShortsFilter(cfg, tipValue)
    };
    if (cursor) payload.start_cursor = cursor;
    var data = await fetchJson('https://api.notion.com/v1/databases/' + cfg.NOTION_DATABASE_ID + '/query', {
      method: 'POST',
      headers: notionHeaders(cfg),
      body: JSON.stringify(payload)
    });
    if (data.object === 'error') throw new Error('Notion query failed: ' + data.message);
    (data.results || []).forEach(function (page) { rows.push(parseNotionRow(page)); });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

export function parseNotionRow(page) {
  var props = page.properties;
  var name = (props['Name'].title || []).map(function (t) { return t.plain_text; }).join('');
  var cod = richTextToString(props['Cod']); // "Cod" is a plain text (rich_text) property, same shape as "Text"
  var text = richTextToString(props['Text']);
  var dateStart = props['Data Postare'] && props['Data Postare'].date ? props['Data Postare'].date.start : null;
  var youtubeUrl = props['YouTube URL'] ? props['YouTube URL'].url : null;
  var tiktokUrl = props['TikTok URL'] ? props['TikTok URL'].url : null;
  var instagramUrl = props['Instagram URL'] ? props['Instagram URL'].url : null;
  var facebookUrl = props['Facebook URL'] ? props['Facebook URL'].url : null;
  var thumbnailUrl = extractThumbnailUrl(props['Thumbnail']);
  return { pageId: page.id, name: name, cod: cod, text: text, postDate: dateStart, youtubeUrl: youtubeUrl, tiktokUrl: tiktokUrl, instagramUrl: instagramUrl, facebookUrl: facebookUrl, thumbnailUrl: thumbnailUrl };
}

export function extractThumbnailUrl(prop) {
  if (!prop || !prop.files || !prop.files.length) return null;
  var f = prop.files[0];
  if (f.type === 'external' && f.external) return f.external.url;
  if (f.type === 'file' && f.file) return f.file.url;
  return null;
}

export function richTextToString(prop) {
  if (!prop || !prop.rich_text) return '';
  return prop.rich_text.map(function (t) { return t.plain_text; }).join('');
}

// Notion writes used to be fire-and-forget (fetchJson's result was never
// even captured), so a rate-limited or otherwise-rejected write failed
// completely silently - no log line, no exception, nothing. That turned out
// to be a real problem: running two backfill scripts against the same
// integration token at once (each doing 1000+ sequential find+write calls)
// tripped Notion's rate limit partway through, and most of a day's worth of
// Facebook writes just vanished with zero trace. This wraps every write with
// a few retries on rate-limiting and a loud console.log on anything else
// that fails, so a re-run's log actually says what happened instead of
// reporting a write count that was never verified.
async function notionWrite(url, options, label) {
  var maxAttempts = 4;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var result = await fetchJson(url, options);
    if (!result || result.object !== 'error') return result;
    if (result.code === 'rate_limited' && attempt < maxAttempts) {
      await new Promise(function (resolve) { setTimeout(resolve, attempt * 800); });
      continue;
    }
    console.log('Notion write failed (' + label + '): ' + result.message);
    return result;
  }
}

export async function updateNotionPage(cfg, pageId, properties) {
  return notionWrite('https://api.notion.com/v1/pages/' + pageId, {
    method: 'PATCH',
    headers: notionHeaders(cfg),
    body: JSON.stringify({ properties: properties })
  }, 'update ' + pageId);
}

export async function createNotionPage(cfg, databaseId, properties) {
  return notionWrite('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: notionHeaders(cfg),
    body: JSON.stringify({ parent: { database_id: databaseId }, properties: properties })
  }, 'create in ' + databaseId);
}

// Moves a page to Notion's trash - for one-time cleanup of bad historical
// rows (see scripts/backfill-clean-instagram-zero-views.js). Distinct from
// updateNotionPage, which only ever touches properties.
export async function archiveNotionPage(cfg, pageId) {
  await fetchJson('https://api.notion.com/v1/pages/' + pageId, {
    method: 'PATCH',
    headers: notionHeaders(cfg),
    body: JSON.stringify({ archived: true })
  });
}

export async function queryNotionDatabase(cfg, databaseId, payload) {
  return fetchJson('https://api.notion.com/v1/databases/' + databaseId + '/query', {
    method: 'POST',
    headers: notionHeaders(cfg),
    body: JSON.stringify(payload || { page_size: 100 })
  });
}

// Upserts one row per { "YYYY-MM": views } entry into MONTHLY_VIEWS_DATABASE_ID.
// Shared by every platform's monthly sync (youtube/facebook/instagram/tiktok).
export async function writeMonthlyViews(cfg, platform, source, monthlyMap) {
  for (var monthKey of Object.keys(monthlyMap)) {
    var views = monthlyMap[monthKey];
    var monthStart = monthKey + '-01';
    var existingId = await findMonthlyViewsRow(cfg, platform, monthStart);
    var props = {
      'Label': { title: [{ text: { content: platform + ' · ' + monthKey } }] },
      'Platform': { select: { name: platform } },
      'Month': { date: { start: monthStart } },
      'Views': { number: views },
      'Source': { select: { name: source } },
      'Synced At': { date: { start: new Date().toISOString() } }
    };
    if (existingId) {
      await updateNotionPage(cfg, existingId, props);
    } else {
      await createNotionPage(cfg, cfg.MONTHLY_VIEWS_DATABASE_ID, props);
    }
  }
}

export async function findMonthlyViewsRow(cfg, platform, monthStart) {
  var data = await queryNotionDatabase(cfg, cfg.MONTHLY_VIEWS_DATABASE_ID, {
    filter: {
      and: [
        { property: 'Platform', select: { equals: platform } },
        { property: 'Month', date: { equals: monthStart } }
      ]
    },
    page_size: 1
  });
  if (data.object === 'error' || !data.results || !data.results.length) return null;
  return data.results[0].id;
}

// Day-grained sibling of writeMonthlyViews/findMonthlyViewsRow, writing to
// DAILY_VIEWS_DATABASE_ID instead - powers the dashboard's custom date-range
// "Total views" KPI with real per-day numbers instead of a post-date-filtered
// lifetime-total estimate. See src/dailyViews.js.
export async function writeDailyViews(cfg, platform, source, dailyMap) {
  for (var dateKey of Object.keys(dailyMap)) {
    var views = dailyMap[dateKey];
    var existingId = await findDailyViewsRow(cfg, platform, dateKey);
    var props = {
      'Label': { title: [{ text: { content: platform + ' · ' + dateKey } }] },
      'Platform': { select: { name: platform } },
      'Date': { date: { start: dateKey } },
      'Views': { number: views },
      'Source': { select: { name: source } },
      'Synced At': { date: { start: new Date().toISOString() } }
    };
    if (existingId) {
      await updateNotionPage(cfg, existingId, props);
    } else {
      await createNotionPage(cfg, cfg.DAILY_VIEWS_DATABASE_ID, props);
    }
  }
}

export async function findDailyViewsRow(cfg, platform, dateKey) {
  var data = await queryNotionDatabase(cfg, cfg.DAILY_VIEWS_DATABASE_ID, {
    filter: {
      and: [
        { property: 'Platform', select: { equals: platform } },
        { property: 'Date', date: { equals: dateKey } }
      ]
    },
    page_size: 1
  });
  if (data.object === 'error' || !data.results || !data.results.length) return null;
  return data.results[0].id;
}

// One immutable row per platform per day, into FOLLOWER_SNAPSHOTS_DATABASE_ID.
// The regular daily sync (src/audience.js) only ever writes today's single
// snapshot via this function; the full historical backfill
// (scripts/backfill-follower-history.js) uses the bulk writeFollowerSnapshots
// below instead.
export async function writeFollowerSnapshot(cfg, platform, dateKey, followers) {
  var existingId = await findFollowerSnapshotRow(cfg, platform, dateKey);
  var props = {
    'Label': { title: [{ text: { content: platform + ' · ' + dateKey } }] },
    'Platform': { select: { name: platform } },
    'Date': { date: { start: dateKey } },
    'Followers': { number: followers },
    'Synced At': { date: { start: new Date().toISOString() } }
  };
  if (existingId) {
    await updateNotionPage(cfg, existingId, props);
  } else {
    await createNotionPage(cfg, cfg.FOLLOWER_SNAPSHOTS_DATABASE_ID, props);
  }
}

// Bulk sibling of writeFollowerSnapshot, for backfilling a whole
// { "YYYY-MM-DD": followers } map at once - see
// scripts/backfill-follower-history.js.
export async function writeFollowerSnapshots(cfg, platform, dailyMap) {
  for (var dateKey of Object.keys(dailyMap)) {
    await writeFollowerSnapshot(cfg, platform, dateKey, dailyMap[dateKey]);
  }
}

export async function findFollowerSnapshotRow(cfg, platform, dateKey) {
  var data = await queryNotionDatabase(cfg, cfg.FOLLOWER_SNAPSHOTS_DATABASE_ID, {
    filter: {
      and: [
        { property: 'Platform', select: { equals: platform } },
        { property: 'Date', date: { equals: dateKey } }
      ]
    },
    page_size: 1
  });
  if (data.object === 'error' || !data.results || !data.results.length) return null;
  return data.results[0].id;
}

// ===== Matching (shared across platforms) =====
// Primary key: "Data Postare" vs the post's publish date (same calendar day
// in SYNC_TIMEZONE, with a +-1 day fallback). Among same-day candidates, the
// platform caption/description must roughly match the Notion "Text"
// property to confirm/disambiguate - a date match alone is only trusted
// when it's the sole candidate for that day.

export function matchContent(postDate, rowText, candidates) {
  if (!postDate) return null;

  var dated = candidatesForDate(postDate, candidates, 0);
  if (!dated.length) dated = candidatesForDate(postDate, candidates, 1);
  if (!dated.length) return null;

  var target = normalize(rowText);
  if (target) {
    var ranked = rankBySimilarity(target, dated, function (c) { return normalize(c.text); });
    if (ranked.length && ranked[0].score >= TEXT_MATCH_THRESHOLD &&
        (ranked.length === 1 || ranked[0].score - ranked[1].score >= TEXT_MARGIN)) {
      return { id: ranked[0].item.id, method: 'date+text', score: ranked[0].score };
    }
    return null; // candidates existed but none matched the Text property well enough
  }

  if (dated.length === 1) {
    return { id: dated[0].id, method: 'date-only (no Text to verify)', score: null };
  }
  return null;
}

// Exported so youtube.js can sanity-check an already-cached URL against the
// row's *current* "Data Postare" - see textMatches below for why date alone
// isn't a safe invalidation signal on its own.
export function daysApart(dateA, dateB) {
  var msA = new Date(dateKeyInTz(dateA) + 'T00:00:00').getTime();
  var msB = new Date(dateKeyInTz(dateB) + 'T00:00:00').getTime();
  return Math.round(Math.abs(msA - msB) / 86400000);
}

function candidatesForDate(postDate, candidates, dayTolerance) {
  return candidates.filter(function (c) { return daysApart(postDate, c.publishedAt) <= dayTolerance; });
}


function rankBySimilarity(target, candidates, getText) {
  return candidates
    .map(function (item) { return { item: item, score: diceCoefficient(target, getText(item)) }; })
    .sort(function (a, b) { return b.score - a.score; });
}

export function findById(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function normalize(s) {
  if (!s) return '';
  var map = { 'ă': 'a', 'â': 'a', 'î': 'i', 'ș': 's', 'ş': 's', 'ț': 't', 'ţ': 't' };
  return s.toLowerCase().replace(/[ăâîșşțţ]/g, function (c) { return map[c]; })
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s) {
  var grams = [];
  for (var i = 0; i < s.length - 1; i++) grams.push(s.substring(i, i + 2));
  return grams;
}

function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  var A = bigrams(a);
  var B = bigrams(b).slice();
  if (!A.length || !B.length) return 0;
  var totalLength = A.length + B.length; // capture before B gets mutated below
  var matches = 0;
  A.forEach(function (g) {
    var idx = B.indexOf(g);
    if (idx !== -1) { matches++; B.splice(idx, 1); }
  });
  return (2 * matches) / totalLength;
}

// ===== Cross-platform report/write helpers =====

export function buildShortsFilter(cfg, tipValue) {
  var tip = tipValue || 'Short';
  var and = [{ property: 'Postat?', checkbox: { equals: true } }];
  if (cfg.NOTION_FILTER_TIP) {
    // Most clients' "Tip" property is multi_select (a row can be tagged
    // both Short and Long); Darcom Energy's is a plain single select
    // instead - cfg.TIP_PROPERTY_TYPE picks the matching Notion filter
    // shape per client. Defaults to multi_select so every existing
    // client's behavior/tests are unaffected.
    //
    // tipValue lets a caller target "Long" instead of the default "Short"
    // - used by sync.js's same-database Long Form pass (Darcom), which
    // reuses this same filter/database rather than Miradex's separate
    // Long Form database.
    var tipFilter = cfg.TIP_PROPERTY_TYPE === 'select'
      ? { property: 'Tip', select: { equals: tip } }
      : { property: 'Tip', multi_select: { contains: tip } };
    and.unshift(tipFilter);
  }
  return { and: and };
}

export function buildPlatformReport(rows, results) {
  var matchedPageIds = {};
  results.forEach(function (r) { matchedPageIds[r.row.pageId] = true; });
  var unmatched = rows.filter(function (row) { return !matchedPageIds[row.pageId]; });
  return { results: results, unmatched: unmatched };
}

function setNum(props, key, value) {
  if (typeof value === 'number') props[key] = { number: value };
}

export function buildUpdatePayloads(cfg, rows, yt, fb, ig, tt) {
  var byPage = {};
  function entryFor(row) {
    if (!byPage[row.pageId]) byPage[row.pageId] = {};
    return byPage[row.pageId];
  }

  yt.results.forEach(function (r) {
    var props = entryFor(r.row);
    props[cfg.YT_FIELD_NAME] = { number: r.views };
    if (r.url) props['YouTube URL'] = { url: r.url };
    // Off by default - see cfg.SYNC_TITLE_FROM_YOUTUBE's comment in
    // config.js. Written every run a title is known (not just on a fresh
    // match), so a video renamed on YouTube after the fact stays in sync.
    if (cfg.SYNC_TITLE_FROM_YOUTUBE && r.youtubeTitle) {
      props['Name'] = { title: [{ text: { content: r.youtubeTitle } }] };
    }
    // Duration only needs one source since it's the same video everywhere -
    // YouTube is used since every row is matched there and it's a single
    // extra field on a call the sync already makes (see
    // fetchYouTubeViewCounts), unlike Facebook (a separate field-expansion
    // request) or Instagram/TikTok (no duration field available at all).
    setNum(props, 'Duration (s)', r.duration);
    setNum(props, 'YT Likes', r.likes);
    setNum(props, 'YT Comments', r.comments);
    setNum(props, 'YT Hook Rate', r.hookRate);
    // Field name is configurable (defaults to "YT Retention @3s") - Long
    // Form's sync pass points this at "YT Retention @30s" instead, since
    // cfg.RETENTION_WINDOW_SECONDS there is 30, not 3 (see src/sync.js and
    // pickRetentionAtWindow's comment in youtube.js for why).
    setNum(props, cfg.RETENTION_WINDOW_FIELD_NAME, r.retentionAtWindow);
    setNum(props, 'YT Avg Watch %', r.avgWatchPct);
    setNum(props, 'YT Avg Watch Time (s)', r.avgWatchTimeS);
    if (typeof r.relativeRetentionPerformance === 'number') {
      props['YT Retention vs Similar'] = { number: Math.round(r.relativeRetentionPerformance * 1000) / 10 };
    }
    // Same reasoning as Facebook's retention graph - not a scalar, so it's
    // compact JSON in a rich_text column rather than one column per point.
    if (r.retention) props['YT Retention Graph'] = { rich_text: [{ text: { content: JSON.stringify(r.retention) } }] };
  });
  if (fb) {
    fb.results.forEach(function (r) {
      var props = entryFor(r.row);
      props[cfg.FB_FIELD_NAME] = { number: r.views };
      if (r.url) props['Facebook URL'] = { url: r.url };
      setNum(props, 'FB Likes', r.likes);
      setNum(props, 'FB Hook Rate', r.hookRate);
      setNum(props, 'FB Avg Watch %', r.avgWatchPct);
      setNum(props, 'FB Avg Watch Time (s)', r.avgWatchTimeS);
      // Not a scalar - the only metric here that isn't - so it's stored as
      // compact JSON rather than getting its own column-per-second. Small
      // enough (a Reel's length in points) to fit one rich_text block well
      // under Notion's 2000-character limit.
      if (r.retention) props['FB Retention Graph'] = { rich_text: [{ text: { content: JSON.stringify(r.retention) } }] };
    });
  }
  if (ig) {
    ig.results.forEach(function (r) {
      var props = entryFor(r.row);
      props[cfg.IG_FIELD_NAME] = { number: r.views };
      if (r.url) props['Instagram URL'] = { url: r.url };
      setNum(props, 'IG Likes', r.likes);
      setNum(props, 'IG Comments', r.comments);
      setNum(props, 'IG Saves', r.saves);
      setNum(props, 'IG Shares', r.shares);
      setNum(props, 'IG Hook Rate', r.hookRate);
      setNum(props, 'IG Avg Watch %', r.avgWatchPct);
      setNum(props, 'IG Avg Watch Time (s)', r.avgWatchTimeS);
    });
  }
  if (tt) {
    tt.results.forEach(function (r) {
      var props = entryFor(r.row);
      props[cfg.TT_FIELD_NAME] = { number: r.views };
      setNum(props, 'TT Likes', r.likes);
      setNum(props, 'TT Comments', r.comments);
      setNum(props, 'TT Shares', r.shares);
      setNum(props, 'TT Saves', r.saves);
    });
  }

  return byPage;
}

export async function writeUpdates(cfg, rows, yt, fb, ig, tt) {
  var byPage = buildUpdatePayloads(cfg, rows, yt, fb, ig, tt);
  for (var pageId of Object.keys(byPage)) {
    await updateNotionPage(cfg, pageId, byPage[pageId]);
  }
}
