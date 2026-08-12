import fs from 'node:fs/promises';
import path from 'node:path';
import { queryNotionDatabase, richTextToString, buildShortsFilter } from './notion.js';
import { isoDate } from './util.js';

// "YouTube"/"Facebook"/"Instagram"/"TikTok" (as stored in the Channel Stats
// and Monthly Views databases) -> the short keys the dashboard template uses.
export function platformKey(platformName) {
  switch (platformName) {
    case 'YouTube': return 'yt';
    case 'Facebook': return 'fb';
    case 'Instagram': return 'ig';
    case 'TikTok': return 'tt';
    default: return null;
  }
}

export function buildDashboardRow(cfg, page, thumbMap) {
  var props = page.properties;
  var postDate = props['Data Postare'] && props['Data Postare'].date ? props['Data Postare'].date.start : null;
  if (!postDate) return null; // dashboard places every short in time - skip anything without a post date
  var name = (props['Name'].title || []).map(function (t) { return t.plain_text; }).join('').trim();
  var cod = richTextToString(props['Cod']);
  var igLink = props['Instagram URL'] ? props['Instagram URL'].url : null;
  var ytLink = props['YouTube URL'] ? props['YouTube URL'].url : null;
  var fbLink = props['Facebook URL'] ? props['Facebook URL'].url : null;
  var ttLink = props['TikTok URL'] ? props['TikTok URL'].url : null;
  var link = igLink || ytLink || fbLink || ttLink || null;
  return [
    name,
    cod,
    props[cfg.YT_FIELD_NAME].number,
    props[cfg.FB_FIELD_NAME].number,
    props[cfg.IG_FIELD_NAME].number,
    props[cfg.TT_FIELD_NAME].number,
    postDate,
    link,
    richTextToString(props['Transcript']) || null,
    thumbMap[cod] || null
  ];
}

function numOrNull(prop) { return prop && typeof prop.number === 'number' ? prop.number : null; }

// Per-video engagement/hook-rate/watch-time detail, keyed by "Cod" - kept
// separate from the RAW row array (rather than growing it) since this is
// "click to expand" data the video-detail popup needs, not something every
// row render should carry inline. Only the platforms that actually expose
// each metric get a non-null value here - see youtube.js/facebook.js/
// instagram.js/tiktok.js for what's available per platform and why.
function retentionOrNull(prop) {
  var raw = prop ? richTextToString(prop) : '';
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export function buildVideoDetail(page) {
  var props = page.properties;
  return {
    durationS: numOrNull(props['Duration (s)']),
    hook: richTextToString(props['Written Hook']) || null,
    yt: {
      likes: numOrNull(props['YT Likes']), comments: numOrNull(props['YT Comments']),
      hookRate: numOrNull(props['YT Hook Rate']), retentionAt3s: numOrNull(props['YT Retention @3s']),
      avgWatchPct: numOrNull(props['YT Avg Watch %']),
      avgWatchTimeS: numOrNull(props['YT Avg Watch Time (s)']),
      retentionVsSimilar: numOrNull(props['YT Retention vs Similar']),
      retention: retentionOrNull(props['YT Retention Graph'])
    },
    fb: {
      likes: numOrNull(props['FB Likes']), hookRate: numOrNull(props['FB Hook Rate']),
      avgWatchPct: numOrNull(props['FB Avg Watch %']), avgWatchTimeS: numOrNull(props['FB Avg Watch Time (s)']),
      retention: retentionOrNull(props['FB Retention Graph'])
    },
    ig: {
      likes: numOrNull(props['IG Likes']), comments: numOrNull(props['IG Comments']),
      saves: numOrNull(props['IG Saves']), shares: numOrNull(props['IG Shares']),
      hookRate: numOrNull(props['IG Hook Rate']), avgWatchPct: numOrNull(props['IG Avg Watch %']),
      avgWatchTimeS: numOrNull(props['IG Avg Watch Time (s)'])
    },
    tt: {
      likes: numOrNull(props['TT Likes']), comments: numOrNull(props['TT Comments']),
      shares: numOrNull(props['TT Shares']), saves: numOrNull(props['TT Saves'])
    }
  };
}

// Reads the fields the dashboard needs (view counts, per-platform URLs,
// transcript) that the sync path's parseNotionRow doesn't - kept separate
// so the sync path isn't carrying fields it never uses.
// Stage 2 (Claude) scoring output, keyed by the Video Analysis row's "Video"
// relation target - null (not five nulls) when a row hasn't been scored yet
// (Hook Score absent), so the dashboard can tell "not scored" apart from
// "scored zero" and skip rendering the section entirely for the former.
export function claudeScoresOrNull(props) {
  var hookScore = numOrNull(props['Hook Score']);
  if (hookScore === null) return null;
  return {
    hookScore: hookScore,
    structureScore: numOrNull(props['Structure Score']),
    formatScore: numOrNull(props['Format Score']),
    pacingScore: numOrNull(props['Pacing Score']),
    ctaScore: numOrNull(props['CTA Score']),
    overallNotes: richTextToString(props['Overall Notes']) || null,
    performanceNotes: richTextToString(props['Performance Notes']) || null,
    reusablePattern: richTextToString(props['Reusable Pattern']) || null
  };
}

// Reads every completed (this pipeline version's) Video Analysis row once
// and keys the result by the linked Video page's id, rather than querying
// per-video - the DB is small enough (one row per analyzed video) that a
// single full scan is simpler and cheaper than N relation lookups.
//
// A row only ever gets created once Gemini's Stage 1 extraction has run
// (both createDraftAnalysis and createFullAnalysis in videoAnalysisNotion.js
// always write 'Raw Extraction' up front) - so a videoPageId simply being a
// key in this map means "Gemini extracted it", independent of whether
// Claude has scored it yet. The value is null for extracted-but-not-yet-
// scored rows and the scores object once Claude has run, so callers can
// tell "not extracted at all" (key absent) apart from "extracted, not
// scored" (key present, value null) apart from "fully scored" (value set).
export async function fetchVideoAnalysisByVideoPageId(cfg) {
  var map = {};
  if (!cfg.VIDEO_ANALYSIS_DATABASE_ID) return map;
  var cursor = null;
  do {
    var payload = {
      page_size: 100,
      filter: { property: 'Pipeline Version', select: { equals: cfg.PIPELINE_VERSION } }
    };
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, cfg.VIDEO_ANALYSIS_DATABASE_ID, payload);
    if (data.object === 'error') throw new Error('Video Analysis query failed: ' + data.message);
    (data.results || []).forEach(function (page) {
      var props = page.properties;
      var relation = props['Video'] && props['Video'].relation;
      var videoPageId = relation && relation[0] ? relation[0].id : null;
      if (videoPageId) map[videoPageId] = claudeScoresOrNull(props);
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return map;
}

export async function fetchDashboardRows(cfg, thumbMap) {
  var out = [];
  var details = {};
  var pageIdByCod = {};
  var rowByCod = {};
  var cursor = null;
  do {
    var payload = {
      page_size: 100,
      filter: buildShortsFilter(cfg)
    };
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, cfg.NOTION_DATABASE_ID, payload);
    if (data.object === 'error') throw new Error('Notion query failed: ' + data.message);
    (data.results || []).forEach(function (page) {
      var row = buildDashboardRow(cfg, page, thumbMap);
      if (row) {
        out.push(row);
        if (row[1]) {
          details[row[1]] = buildVideoDetail(page);
          pageIdByCod[row[1]] = page.id;
          rowByCod[row[1]] = row;
        }
      }
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  // Appended onto the fixed 10-element row (rather than folded into
  // buildDashboardRow) since these two flags depend on the Video Analysis
  // DB, which is only fetched here, after every dashboard row already
  // exists - same "row[1]" cod-matching this function already does for
  // details/pageIdByCod above. Every row gets both flags (true/false, not
  // just present-when-true) so the template's fixed-position RAW array
  // indexing stays reliable for every row.
  var analysisByPageId = await fetchVideoAnalysisByVideoPageId(cfg);
  Object.keys(pageIdByCod).forEach(function (cod) {
    var pageId = pageIdByCod[cod];
    var geminiExtracted = Object.prototype.hasOwnProperty.call(analysisByPageId, pageId);
    details[cod].geminiExtracted = geminiExtracted;
    var claude = analysisByPageId[pageId];
    if (claude) details[cod].claude = claude;
    rowByCod[cod].push(geminiExtracted, !!claude);
  });

  out.sort(function (a, b) { return a[6] < b[6] ? -1 : a[6] > b[6] ? 1 : 0; }); // ascending by post date
  return { rows: out, details: details };
}

// Single-platform sibling of buildDashboardRow, for the Long Form database
// (YouTube-only - no Facebook/Instagram/TikTok view/like/comment properties
// exist on that schema, so this doesn't reuse buildDashboardRow's fixed
// 4-platform shape). The "hook" column deliberately reads
// LONG_FORM_RETENTION_FIELD_NAME ("YT Retention @30s" by default), not "YT
// Hook Rate" - that field is engagedViews/views, a Shorts-shaped metric
// (see the comment on syncYouTube's Long Form override in sync.js): almost
// every Long Form viewer is still watching 3 seconds in, so it reads near
// 100% for everything and carries no real signal for this content shape.
export function buildLongFormRow(cfg, page, thumbMap) {
  var props = page.properties;
  var postDate = props['Data Postare'] && props['Data Postare'].date ? props['Data Postare'].date.start : null;
  if (!postDate) return null;
  var name = (props['Name'].title || []).map(function (t) { return t.plain_text; }).join('').trim();
  var cod = richTextToString(props['Cod']);
  var link = props['YouTube URL'] ? props['YouTube URL'].url : null;
  return [
    name,
    cod,
    numOrNull(props[cfg.LONG_FORM_YT_FIELD_NAME]),
    postDate,
    link,
    numOrNull(props['Duration (s)']),
    numOrNull(props['YT Likes']),
    numOrNull(props['YT Comments']),
    numOrNull(props[cfg.LONG_FORM_RETENTION_FIELD_NAME]),
    numOrNull(props['YT Avg Watch %']),
    thumbMap[cod] || null
  ];
}

// Modeled on fetchDashboardRows, but against LONG_FORM_NOTION_DATABASE_ID
// with just the "Postat?" filter - Long Form has no "Tip" property, so
// there's nothing for buildShortsFilter's Tip clause to match against even
// if NOTION_FILTER_TIP were true (it's always false for Miradex today).
export async function fetchLongFormRows(cfg, thumbMap) {
  var out = [];
  if (!cfg.LONG_FORM_NOTION_DATABASE_ID) return out;
  var cursor = null;
  do {
    var payload = {
      page_size: 100,
      filter: { property: 'Postat?', checkbox: { equals: true } }
    };
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, cfg.LONG_FORM_NOTION_DATABASE_ID, payload);
    if (data.object === 'error') throw new Error('Long Form query failed: ' + data.message);
    (data.results || []).forEach(function (page) {
      var row = buildLongFormRow(cfg, page, thumbMap);
      if (row) out.push(row);
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  out.sort(function (a, b) { return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0; }); // ascending by post date
  return out;
}

export async function fetchDashboardAudience(cfg) {
  var audience = {};
  if (!cfg.CHANNEL_STATS_DATABASE_ID) return audience;
  var data = await queryNotionDatabase(cfg, cfg.CHANNEL_STATS_DATABASE_ID, { page_size: 20 });
  if (data.object === 'error') return audience;
  (data.results || []).forEach(function (page) {
    var platform = (page.properties['Platform'].title || []).map(function (t) { return t.plain_text; }).join('');
    var key = platformKey(platform);
    if (!key) return;
    audience[key] = { followers: page.properties['Followers'] ? page.properties['Followers'].number : null };
  });
  return audience;
}

export async function fetchDashboardMonthlyViews(cfg) {
  var monthly = { yt: {}, fb: {}, ig: {}, tt: {} };
  if (!cfg.MONTHLY_VIEWS_DATABASE_ID) return monthly;
  var cursor = null;
  do {
    var payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, cfg.MONTHLY_VIEWS_DATABASE_ID, payload);
    if (data.object === 'error') throw new Error('Monthly Views query failed: ' + data.message);
    (data.results || []).forEach(function (page) {
      var props = page.properties;
      var key = platformKey(props['Platform'] && props['Platform'].select ? props['Platform'].select.name : null);
      var monthStart = props['Month'] && props['Month'].date ? props['Month'].date.start : null;
      var views = props['Views'] ? props['Views'].number : null;
      if (!key || !monthStart || typeof views !== 'number') return;
      monthly[key][monthStart.slice(0, 7)] = views;
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return monthly;
}

export async function fetchDashboardDailyViews(cfg) {
  var daily = { yt: {}, fb: {}, ig: {} };
  if (!cfg.DAILY_VIEWS_DATABASE_ID) return daily;
  var cursor = null;
  do {
    var payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, cfg.DAILY_VIEWS_DATABASE_ID, payload);
    if (data.object === 'error') throw new Error('Daily Views query failed: ' + data.message);
    (data.results || []).forEach(function (page) {
      var props = page.properties;
      var key = platformKey(props['Platform'] && props['Platform'].select ? props['Platform'].select.name : null);
      var dateStart = props['Date'] && props['Date'].date ? props['Date'].date.start : null;
      var views = props['Views'] ? props['Views'].number : null;
      if (!key || !daily[key] || !dateStart || typeof views !== 'number') return;
      daily[key][dateStart.slice(0, 10)] = views;
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return daily;
}

export async function fetchDashboardFollowerSnapshots(cfg) {
  var daily = { yt: {}, fb: {}, ig: {}, tt: {} };
  if (!cfg.FOLLOWER_SNAPSHOTS_DATABASE_ID) return daily;
  var cursor = null;
  do {
    var payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, cfg.FOLLOWER_SNAPSHOTS_DATABASE_ID, payload);
    if (data.object === 'error') throw new Error('Follower Snapshots query failed: ' + data.message);
    (data.results || []).forEach(function (page) {
      var props = page.properties;
      var key = platformKey(props['Platform'] && props['Platform'].select ? props['Platform'].select.name : null);
      var dateStart = props['Date'] && props['Date'].date ? props['Date'].date.start : null;
      var followers = props['Followers'] ? props['Followers'].number : null;
      if (!key || !dateStart || typeof followers !== 'number') return;
      daily[key][dateStart.slice(0, 10)] = followers;
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return daily;
}

// Builds the dashboard from templates/DashboardTemplate.html (a
// self-contained page - CSS + markup + client-side JS - with a handful of
// token placeholders) and writes the merged result straight to
// dist/clients/isogreen/index.html as a plain static file. Unlike posting
// through WordPress's content field, a static file never passes through
// wpautop/kses, so the embedded <script> block and its JSON payload survive
// intact.
export async function buildDashboard(cfg, thumbMap, outDir) {
  var rowsResult = await fetchDashboardRows(cfg, thumbMap);
  var rows = rowsResult.rows;
  var videoDetails = rowsResult.details;
  var audience = await fetchDashboardAudience(cfg);
  var monthly = await fetchDashboardMonthlyViews(cfg);
  var daily = await fetchDashboardDailyViews(cfg);
  var followerSnapshots = await fetchDashboardFollowerSnapshots(cfg);
  // Empty array (not omitted) when disabled, so the template's embedded
  // `var LONG_FORM = ...;` is always valid JS/JSON for every client,
  // including Isogreen, which has no Long Form database. Caught locally
  // (not left to propagate) - a Long Form-specific problem (e.g. the
  // database not yet shared with the Notion integration) must not take
  // down the entire dashboard/reports build for the rest of the client's
  // data, the same way syncThumbnails/syncAudience etc. are individually
  // guarded in sync.js.
  var longFormRows = [];
  try { longFormRows = await fetchLongFormRows(cfg, thumbMap); } catch (e) { console.log('Long Form dashboard fetch failed: ' + e); }

  var templatePath = new URL('../templates/DashboardTemplate.html', import.meta.url);
  var html = await fs.readFile(templatePath, 'utf8');
  html = html
    .replace('/*__RAW_DATA__*/', JSON.stringify(rows))
    .replace('/*__VIDEO_DETAILS_DATA__*/', JSON.stringify(videoDetails))
    .replace('/*__AUDIENCE_DATA__*/', JSON.stringify(audience))
    .replace('/*__MONTHLY_VIEWS_DATA__*/', JSON.stringify(monthly))
    .replace('/*__DAILY_VIEWS_DATA__*/', JSON.stringify(daily))
    .replace('/*__FOLLOWER_SNAPSHOTS_DATA__*/', JSON.stringify(followerSnapshots))
    .replace('/*__LONG_FORM_DATA__*/', JSON.stringify(longFormRows))
    .replace('__LAST_SYNCED__', isoDate(new Date()))
    .split('__CLIENT_NAME__').join(cfg.CLIENT_NAME);

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'index.html'), html, 'utf8');
  console.log('Dashboard written to ' + path.join(outDir, 'index.html'));

  // Returned so callers (src/reports.js, via sync.js) can reuse this same
  // fetched data instead of re-querying Notion for the same rows/stats.
  return { rows: rows, videoDetails: videoDetails, audience: audience, monthly: monthly, daily: daily, followerSnapshots: followerSnapshots, longFormRows: longFormRows };
}

export function renderClientLinks(slugs) {
  return slugs.slice().sort().map(function (slug) {
    return '      <li><a href="/clients/' + slug + '/">' + slug.toUpperCase() + '</a></li>';
  }).join('\n');
}

// Static picker page at /clients/ - regenerated from whichever client
// subdirectories are actually present under clientsDir at publish time (see
// scripts/build-clients-index.js), so adding a client is a schema/secrets
// change, not a template edit.
export async function buildClientsIndex(clientsDir) {
  var entries = await fs.readdir(clientsDir, { withFileTypes: true }).catch(function () { return []; });
  var slugs = entries.filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; });

  var templatePath = new URL('../templates/ClientsIndex.html', import.meta.url);
  var html = await fs.readFile(templatePath, 'utf8');
  html = html.replace('<!--__CLIENT_LINKS__-->', renderClientLinks(slugs));

  await fs.mkdir(clientsDir, { recursive: true });
  await fs.writeFile(path.join(clientsDir, 'index.html'), html, 'utf8');
  console.log('Clients index written to ' + path.join(clientsDir, 'index.html') + ' (' + slugs.length + ' client(s): ' + slugs.slice().sort().join(', ') + ')');
}
