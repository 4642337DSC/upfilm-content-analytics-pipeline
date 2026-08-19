import { createNotionPage, queryNotionDatabase, richTextToString, extractCod, updateNotionPage } from './notion.js';

// Rich text objects are capped at 2000 chars each by the Notion API - the
// raw extraction JSON (audit trail for re-scoring, see analysis.schema.json
// section 4) routinely runs longer than that, so it's split across multiple
// text objects in the same property rather than truncated.
var RICH_TEXT_CHUNK_SIZE = 1900;

function chunkRichText(text) {
  var chunks = [];
  for (var i = 0; i < text.length; i += RICH_TEXT_CHUNK_SIZE) {
    chunks.push({ type: 'text', text: { content: text.slice(i, i + RICH_TEXT_CHUNK_SIZE) } });
  }
  return chunks.length ? chunks : [{ type: 'text', text: { content: '' } }];
}

async function queryAll(cfg, databaseId, filter) {
  var results = [];
  var cursor = null;
  do {
    var payload = { page_size: 100 };
    if (filter) payload.filter = filter;
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, databaseId, payload);
    if (data.object === 'error') throw new Error('Notion query failed: ' + data.message);
    results.push.apply(results, data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

// Handles both plain number properties and formula properties that resolve
// to a number (e.g. the Video DB's "Total Views", which sums the 4 platform
// view counts via a Notion formula rather than storing a number directly).
function numberProp(props, name) {
  var prop = props[name];
  if (!prop) return null;
  if (typeof prop.number === 'number') return prop.number;
  if (prop.formula && typeof prop.formula.number === 'number') return prop.formula.number;
  return null;
}

// Video DB rows that don't yet have a page in the Video Analysis DB for the
// given pipeline version - source list for the pipeline orchestrator.
// Gemini is pointed at the "YouTube URL" property directly (no download/
// upload step - see src/geminiExtract.js), so only videos actually posted
// to YouTube are eligible; TikTok/IG/FB-only videos are skipped for now.
export async function fetchAllVideoRows(cfg) {
  var videoRows = await queryAll(cfg, cfg.NOTION_DATABASE_ID);
  return videoRows.map(function (page) { return parseVideoRow(cfg, page); });
}

// Today's video(s) (by "Data Postare") first, then the rest of the backlog
// ordered by view count descending - so a capped/limited run (see
// src/videoAnalysisPipeline.js's --limit) always covers the freshest video
// plus whatever's already proven to be a top performer, instead of
// whatever order Notion happened to return rows in.
export function sortForAnalysis(rows, today) {
  today = today || new Date().toISOString().slice(0, 10);
  return rows.slice().sort(function (a, b) {
    var aToday = a.postDate === today;
    var bToday = b.postDate === today;
    if (aToday !== bToday) return aToday ? -1 : 1;
    var aViews = typeof a.views === 'number' ? a.views : -1;
    var bViews = typeof b.views === 'number' ? b.views : -1;
    return bViews - aViews;
  });
}

// Inclusive YYYY-MM-DD range filter for a one-off backfill (see
// src/videoAnalysisPipeline.js's --from/--to) - string comparison is safe
// since postDate is always an ISO YYYY-MM-DD from Notion's date property.
export function filterByDateRange(rows, from, to) {
  return rows.filter(function (row) {
    if (!row.postDate) return false;
    if (from && row.postDate < from) return false;
    if (to && row.postDate > to) return false;
    return true;
  });
}

export async function fetchVideosNeedingAnalysis(cfg, pipelineVersion, allRows) {
  var rows = allRows || await fetchAllVideoRows(cfg);
  var analysisRows = await queryAll(cfg, cfg.VIDEO_ANALYSIS_DATABASE_ID, {
    property: 'Pipeline Version',
    select: { equals: pipelineVersion }
  });
  var alreadyAnalyzed = new Set();
  analysisRows.forEach(function (page) {
    var relation = page.properties['Video'] && page.properties['Video'].relation;
    (relation || []).forEach(function (r) { alreadyAnalyzed.add(r.id); });
  });

  var pending = rows
    .filter(function (row) { return !alreadyAnalyzed.has(row.pageId); })
    .filter(function (row) { return !!row.youtubeUrl; });
  return sortForAnalysis(pending);
}

function parseVideoRow(cfg, page) {
  var props = page.properties;
  var name = (props['Name'] && props['Name'].title || []).map(function (t) { return t.plain_text; }).join('');
  return {
    pageId: page.id,
    name: name,
    cod: extractCod(props['Cod']),
    youtubeUrl: props['YouTube URL'] ? props['YouTube URL'].url : null,
    postDate: props['Data Postare'] && props['Data Postare'].date ? props['Data Postare'].date.start : null,
    views: numberProp(props, cfg.VIEWS_FIELD_NAME),
    hookRate: numberProp(props, cfg.HOOK_RATE_FIELD_NAME),
    comments: numberProp(props, cfg.COMMENTS_FIELD_NAME)
  };
}

// Channel baseline (avg views across every row that has a views number) so
// Claude can judge a video relative to its own channel's typical
// performance rather than an absolute number - see prompts/videoAnalysisClaudeScoring.txt.
export function computeChannelBaseline(rows) {
  var withViews = rows.map(function (r) { return r.views; }).filter(function (v) { return typeof v === 'number'; });
  if (!withViews.length) return null;
  var avg = withViews.reduce(function (a, b) { return a + b; }, 0) / withViews.length;
  return { avg_views: Math.round(avg), sample_size: withViews.length };
}

export function buildPerformanceContext(row, channelBaseline) {
  return {
    views: row.views,
    yt_hook_rate: row.hookRate,
    comments: row.comments,
    channel_baseline: channelBaseline
  };
}

async function findAnalysisRow(cfg, videoPageId, pipelineVersion) {
  var data = await queryNotionDatabase(cfg, cfg.VIDEO_ANALYSIS_DATABASE_ID, {
    filter: {
      and: [
        { property: 'Video', relation: { contains: videoPageId } },
        { property: 'Pipeline Version', select: { equals: pipelineVersion } }
      ]
    },
    page_size: 1
  });
  if (data.object === 'error' || !data.results || !data.results.length) return null;
  return data.results[0].id;
}

export function buildAnalysisProps(options) {
  var scores = options.analysis.scores;
  return {
    'Name': { title: [{ text: { content: options.videoName || options.analysis.video_id || options.videoPageId } }] },
    'Video': { relation: [{ id: options.videoPageId }] },
    'Hook Score': { number: scores.hook.score },
    'Structure Score': { number: scores.structure.score },
    'Format Score': { number: scores.format.score },
    'Pacing Score': { number: scores.pacing.score },
    'CTA Score': { number: scores.cta.score },
    'Overall Notes': { rich_text: chunkRichText(options.analysis.overall_notes || '') },
    'Performance Notes': { rich_text: chunkRichText(options.analysis.performance_notes || '') },
    'Reusable Pattern': { rich_text: chunkRichText(options.analysis.reusable_pattern || '') },
    'Raw Extraction': { rich_text: chunkRichText(JSON.stringify(options.rawExtraction)) },
    'Needs Scoring': { checkbox: false },
    'Analyzed Date': { date: { start: new Date().toISOString() } },
    'Pipeline Version': { select: { name: options.pipelineVersion } }
  };
}

// Creates (or updates, if a row for this video+pipeline version already
// exists - keeps re-runs idempotent) the Video Analysis row. rawExtraction
// is stored alongside the scores so a later prompt tweak can re-score
// without re-paying for Gemini video tokens (see src/videoAnalysisPipeline.js).
export async function writeAnalysisResult(cfg, options) {
  var props = buildAnalysisProps(options);
  var existingId = await findAnalysisRow(cfg, options.videoPageId, options.pipelineVersion);
  if (existingId) {
    return updateNotionPage(cfg, existingId, props);
  }
  return createNotionPage(cfg, cfg.VIDEO_ANALYSIS_DATABASE_ID, props);
}

export function buildExtractionOnlyProps(options) {
  return {
    'Name': { title: [{ text: { content: options.videoName || options.rawExtraction.video_id || options.videoPageId } }] },
    'Video': { relation: [{ id: options.videoPageId }] },
    'Raw Extraction': { rich_text: chunkRichText(JSON.stringify(options.rawExtraction)) },
    'Needs Scoring': { checkbox: true },
    'Analyzed Date': { date: { start: new Date().toISOString() } },
    'Pipeline Version': { select: { name: options.pipelineVersion } }
  };
}

// Stage 1 only, no Stage 2 - writes the raw extraction and flags the row
// "Needs Scoring" for a Claude Code agent session to pick up directly
// against Notion (see prompts/videoAnalysisScoringAgentTask.md), instead of
// an ANTHROPIC_API_KEY-backed scoreVideo() call. Same idempotent
// find-or-create as writeAnalysisResult, so a later scoring pass updates
// this same row rather than creating a duplicate.
export async function writeExtractionOnly(cfg, options) {
  var props = buildExtractionOnlyProps(options);
  var existingId = await findAnalysisRow(cfg, options.videoPageId, options.pipelineVersion);
  if (existingId) {
    return updateNotionPage(cfg, existingId, props);
  }
  return createNotionPage(cfg, cfg.VIDEO_ANALYSIS_DATABASE_ID, props);
}

// Rows a Claude Code agent session should score next: this pipeline
// version, flagged "Needs Scoring", with their raw extraction and linked
// Video row's performance context attached.
export async function fetchRowsNeedingScoring(cfg, pipelineVersion) {
  var analysisRows = await queryAll(cfg, cfg.VIDEO_ANALYSIS_DATABASE_ID, {
    and: [
      { property: 'Pipeline Version', select: { equals: pipelineVersion } },
      { property: 'Needs Scoring', checkbox: { equals: true } }
    ]
  });
  var allVideoRows = await fetchAllVideoRows(cfg);
  var videoRowsByPageId = {};
  allVideoRows.forEach(function (row) { videoRowsByPageId[row.pageId] = row; });
  var channelBaseline = computeChannelBaseline(allVideoRows);

  return analysisRows.map(function (page) {
    var relation = page.properties['Video'] && page.properties['Video'].relation;
    var videoPageId = relation && relation[0] ? relation[0].id : null;
    var videoRow = videoPageId ? videoRowsByPageId[videoPageId] : null;
    var rawExtraction;
    try {
      rawExtraction = JSON.parse(richTextToString(page.properties['Raw Extraction']));
    } catch (err) {
      rawExtraction = null;
    }
    return {
      analysisPageId: page.id,
      videoPageId: videoPageId,
      videoName: videoRow ? videoRow.name : null,
      rawExtraction: rawExtraction,
      performance: videoRow ? buildPerformanceContext(videoRow, channelBaseline) : null
    };
  }).filter(function (row) { return row.videoPageId && row.rawExtraction; });
}

export function richTextFromAnalysisPage(page, propertyName) {
  return richTextToString(page.properties[propertyName]);
}
