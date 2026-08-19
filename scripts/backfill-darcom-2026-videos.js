import { getConfig, requireConfig } from '../src/config.js';
import { queryNotionDatabase, parseNotionRow, matchContent, createNotionPage } from '../src/notion.js';
import { fetchAllYouTubeVideos, fetchYouTubeViewCounts, extractYouTubeId } from '../src/youtube.js';
import { fetchAllFacebookVideos } from '../src/facebook.js';
import { fetchAllInstagramMedia } from '../src/instagram.js';

// One-time backfill for a brand-new client (Darcom Energy): unlike the
// regular sync (src/sync.js), which only re-syncs stats for rows that
// already exist in Notion, this discovers videos directly from each
// platform's own upload history and creates the missing Notion rows so the
// regular sync has something to match against going forward.
//
// 2026 only, per Stefan (earlier videos don't matter for this client).
// TikTok is skipped - Zernio has no listing API, only per-URL stats (see
// src/tiktok.js) - so TikTok rows need a URL pasted in by hand later.
//
// Defaults to dry-run (prints the plan, writes nothing). Pass --write to
// actually create the Notion pages.

var WRITE = process.argv.includes('--write');
var YEAR_PREFIX = '2026';
// YouTube's own Shorts definition (up to 3 minutes, raised from 60s in
// 2024) - per Stefan, only genuinely long-form YouTube uploads (webinars,
// trainings, multi-minute guides) should land as "Long"; a 90s Reel-style
// upload is still a Short even though it's over the old 60s bar.
var SHORT_MAX_SECONDS = 180;

var cfg = getConfig();
requireConfig(cfg);
if (!cfg.FB_PAGE_ID || !cfg.FB_PAGE_ACCESS_TOKEN) throw new Error('Set FB_PAGE_ID/FB_PAGE_ACCESS_TOKEN first.');

async function fetchAllRows(cfg) {
  var rows = [];
  var cursor = null;
  do {
    var payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, cfg.NOTION_DATABASE_ID, payload);
    if (data.object === 'error') throw new Error('Notion query failed: ' + data.message);
    (data.results || []).forEach(function (page) { rows.push(parseNotionRow(page)); });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

function isIn2026(dateStr) {
  return typeof dateStr === 'string' && dateStr.slice(0, 4) === YEAR_PREFIX;
}

function dayKey(iso) {
  return iso ? iso.slice(0, 10) : null;
}

// FB/IG captions are full paragraphs with line breaks - for a row Name we
// want just the first line, word-wrapped rather than sliced mid-word.
function captionToTitle(text) {
  var firstLine = (text || '').split('\n')[0].trim();
  if (firstLine.length <= 80) return firstLine || null;
  var cut = firstLine.slice(0, 80);
  var lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

console.log('Fetching existing Notion rows...');
var existingRows = await fetchAllRows(cfg);
console.log('  ' + existingRows.length + ' existing rows.');

console.log('Fetching YouTube uploads...');
var ytVideos = (await fetchAllYouTubeVideos(cfg)).filter(function (v) { return isIn2026(v.publishedAt); });
console.log('  ' + ytVideos.length + ' YouTube uploads in 2026.');

console.log('Fetching YouTube durations (for Short/Long classification)...');
var ytStats = await fetchYouTubeViewCounts(cfg, ytVideos.map(function (v) { return v.id; }));
function tipForDuration(seconds) {
  if (typeof seconds !== 'number') return 'Short'; // unknown - default assumption
  return seconds < SHORT_MAX_SECONDS ? 'Short' : 'Long';
}

console.log('Fetching Facebook Reels...');
var fbVideos = (await fetchAllFacebookVideos(cfg)).filter(function (v) { return isIn2026(v.publishedAt); });
console.log('  ' + fbVideos.length + ' Facebook Reels in 2026.');

console.log('Fetching Instagram media...');
var igMedia = (await fetchAllInstagramMedia(cfg)).filter(function (v) { return isIn2026(v.publishedAt); });
console.log('  ' + igMedia.length + ' Instagram Reels/Videos in 2026.');

// ---- Cross-platform grouping ----
// Anchor on YouTube first (every group with a YouTube video keeps its real
// title), then fold in any Facebook/Instagram post that matches by
// date+caption via the same matchContent() the regular sync uses for
// Notion-row matching - reused here for platform-to-platform matching
// instead, since the date+text-similarity logic is identical either way.
var usedFb = {};
var usedIg = {};
var groups = [];

ytVideos.forEach(function (yt) {
  var fbMatch = matchContent(dayKey(yt.publishedAt), yt.text, fbVideos.filter(function (v) { return !usedFb[v.id]; }));
  var igMatch = matchContent(dayKey(yt.publishedAt), yt.text, igMedia.filter(function (v) { return !usedIg[v.id]; }));
  var fb = fbMatch ? fbVideos.find(function (v) { return v.id === fbMatch.id; }) : null;
  var ig = igMatch ? igMedia.find(function (v) { return v.id === igMatch.id; }) : null;
  if (fb) usedFb[fb.id] = true;
  if (ig) usedIg[ig.id] = true;
  var duration = ytStats[yt.id] ? ytStats[yt.id].duration : undefined;
  groups.push({
    title: yt.title,
    text: yt.text,
    dataPostare: dayKey(yt.publishedAt),
    youtubeUrl: 'https://www.youtube.com/watch?v=' + yt.id,
    facebookUrl: fb ? fb.permalink : null,
    instagramUrl: ig ? ig.permalink : null,
    duration: duration,
    tip: tipForDuration(duration),
    sources: ['youtube'].concat(fb ? ['facebook'] : [], ig ? ['instagram'] : [])
  });
});

fbVideos.filter(function (v) { return !usedFb[v.id]; }).forEach(function (fb) {
  var igMatch = matchContent(dayKey(fb.publishedAt), fb.text, igMedia.filter(function (v) { return !usedIg[v.id]; }));
  var ig = igMatch ? igMedia.find(function (v) { return v.id === igMatch.id; }) : null;
  if (ig) usedIg[ig.id] = true;
  groups.push({
    title: captionToTitle(fb.text) || '(untitled Facebook Reel)',
    text: fb.text,
    dataPostare: dayKey(fb.publishedAt),
    youtubeUrl: null,
    facebookUrl: fb.permalink,
    instagramUrl: ig ? ig.permalink : null,
    tip: 'Short', // no YouTube duration to check - FB Reels/IG Reels are short-form by platform convention
    tipAssumed: true,
    sources: ['facebook'].concat(ig ? ['instagram'] : [])
  });
});

igMedia.filter(function (v) { return !usedIg[v.id]; }).forEach(function (ig) {
  groups.push({
    title: captionToTitle(ig.text) || '(untitled Instagram Reel)',
    text: ig.text,
    dataPostare: dayKey(ig.publishedAt),
    youtubeUrl: null,
    facebookUrl: null,
    instagramUrl: ig.permalink,
    tip: 'Short', // no YouTube duration to check - IG Reels are short-form by platform convention
    tipAssumed: true,
    sources: ['instagram']
  });
});

// ---- Skip groups that already look present in Notion ----
// Existing rows are checked the same way the sync would: same-day (±1) +
// caption similarity via matchContent, plus a direct cached-URL fallback
// for rows that already have a platform URL but no Data Postare/Text set.
function alreadyInNotion(group) {
  var candidates = existingRows.map(function (r) { return { id: r.pageId, text: r.text, publishedAt: r.postDate }; });
  var m = matchContent(group.dataPostare, group.text, candidates);
  if (m) return true;
  return existingRows.some(function (r) {
    return (group.youtubeUrl && r.youtubeUrl === group.youtubeUrl) ||
      (group.instagramUrl && r.instagramUrl === group.instagramUrl);
  });
}

var toCreate = groups.filter(function (g) { return !alreadyInNotion(g); });
var skipped = groups.length - toCreate.length;

console.log('\n=== Plan ===');
console.log(groups.length + ' unique 2026 videos found across YouTube/Facebook/Instagram.');
console.log(skipped + ' already appear to have a matching Notion row - skipped.');
console.log(toCreate.length + ' new rows ' + (WRITE ? 'will be created:' : 'would be created (dry run):'));
var shortCount = toCreate.filter(function (g) { return g.tip === 'Short'; }).length;
var longRows = toCreate.filter(function (g) { return g.tip === 'Long'; });
console.log(shortCount + ' classified Short, ' + longRows.length + ' classified Long (duration >= ' + SHORT_MAX_SECONDS + 's).');

toCreate.forEach(function (g, i) {
  console.log('\n' + (i + 1) + '. [' + g.tip + (g.tipAssumed ? ', assumed' : g.duration != null ? ', ' + g.duration + 's' : '') + '] ' + g.title);
  console.log('   Date: ' + g.dataPostare + '  |  Sources: ' + g.sources.join(', '));
  if (g.youtubeUrl) console.log('   YouTube: ' + g.youtubeUrl);
  if (g.facebookUrl) console.log('   Facebook: ' + g.facebookUrl);
  if (g.instagramUrl) console.log('   Instagram: ' + g.instagramUrl);
});

if (!WRITE) {
  console.log('\nDry run only - nothing written. Re-run with --write to create these rows in Notion.');
  process.exit(0);
}

console.log('\nCreating rows in Notion...');
for (var g of toCreate) {
  var props = {
    'Name': { title: [{ text: { content: g.title } }] },
    'Postat?': { checkbox: true },
    'Tip': { select: { name: g.tip } },
    'Data Postare': { date: { start: g.dataPostare } },
    'Text': { rich_text: [{ text: { content: (g.text || '').slice(0, 1900) } }] }
  };
  if (g.youtubeUrl) props['YouTube URL'] = { url: g.youtubeUrl };
  if (g.facebookUrl) props['Facebook URL'] = { url: g.facebookUrl };
  if (g.instagramUrl) props['Instagram URL'] = { url: g.instagramUrl };
  await createNotionPage(cfg, cfg.NOTION_DATABASE_ID, props);
  console.log('  Created: ' + g.title);
}
console.log('\nDone. Run with CLIENT_SLUG=darcomenergy / TIP_PROPERTY_TYPE=select to pull view counts via npm run sync.');
