import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisProps, buildExtractionOnlyProps, buildPerformanceContext, computeChannelBaseline, filterByDateRange, sortForAnalysis } from './videoAnalysisNotion.js';

var sampleAnalysis = {
  video_id: 'vid_1',
  scores: {
    hook: { score: 7, reasoning: 'r', evidence_timestamps: [1] },
    structure: { score: 6, reasoning: 'r', evidence_timestamps: [] },
    format: { score: 8, reasoning: 'r', evidence_timestamps: [] },
    pacing: { score: 5, reasoning: 'r', evidence_timestamps: [] },
    cta: { score: 4, reasoning: 'r', evidence_timestamps: [] }
  },
  overall_notes: 'notable stuff',
  reusable_pattern: 'quick pattern interrupt at 0-1s'
};

test('buildAnalysisProps writes all five scores, clears Needs Scoring, and tags the pipeline version', () => {
  var props = buildAnalysisProps({
    videoPageId: 'page-1',
    videoName: 'My Video',
    analysis: sampleAnalysis,
    rawExtraction: { video_id: 'vid_1' },
    pipelineVersion: 'v2-gemini-claude'
  });

  assert.equal(props['Hook Score'].number, 7);
  assert.equal(props['Structure Score'].number, 6);
  assert.equal(props['Format Score'].number, 8);
  assert.equal(props['Pacing Score'].number, 5);
  assert.equal(props['CTA Score'].number, 4);
  assert.equal(props['Needs Scoring'].checkbox, false);
  assert.equal(props['Pipeline Version'].select.name, 'v2-gemini-claude');
  assert.equal(props['Video'].relation[0].id, 'page-1');
  assert.equal(props['Name'].title[0].text.content, 'My Video');
});

test('buildAnalysisProps falls back to video_id, then pageId, for the title when no name is given', () => {
  var noName = buildAnalysisProps({ videoPageId: 'page-2', analysis: sampleAnalysis, rawExtraction: {}, pipelineVersion: 'v2' });
  assert.equal(noName['Name'].title[0].text.content, 'vid_1');

  var noNameNoVideoId = buildAnalysisProps({
    videoPageId: 'page-3',
    analysis: { ...sampleAnalysis, video_id: undefined },
    rawExtraction: {},
    pipelineVersion: 'v2'
  });
  assert.equal(noNameNoVideoId['Name'].title[0].text.content, 'page-3');
});

test('buildAnalysisProps chunks a long Raw Extraction across multiple rich_text objects', () => {
  var longExtraction = { full_transcript: 'x'.repeat(5000) };
  var props = buildAnalysisProps({ videoPageId: 'page-1', analysis: sampleAnalysis, rawExtraction: longExtraction, pipelineVersion: 'v2' });
  assert.ok(props['Raw Extraction'].rich_text.length > 1);
  props['Raw Extraction'].rich_text.forEach((chunk) => assert.ok(chunk.text.content.length <= 1900));
});

test('buildExtractionOnlyProps flags Needs Scoring and omits score properties', () => {
  var props = buildExtractionOnlyProps({
    videoPageId: 'page-1',
    videoName: 'My Video',
    rawExtraction: { video_id: 'vid_1' },
    pipelineVersion: 'v2-gemini-claude'
  });

  assert.equal(props['Needs Scoring'].checkbox, true);
  assert.equal(props['Hook Score'], undefined);
  assert.equal(props['Video'].relation[0].id, 'page-1');
  assert.equal(props['Pipeline Version'].select.name, 'v2-gemini-claude');
});

test('computeChannelBaseline averages only rows with a numeric views value', () => {
  var baseline = computeChannelBaseline([{ views: 100 }, { views: 200 }, { views: null }, {}]);
  assert.deepEqual(baseline, { avg_views: 150, sample_size: 2 });
});

test('computeChannelBaseline returns null when no row has views', () => {
  assert.equal(computeChannelBaseline([{ views: null }, {}]), null);
});

test('buildPerformanceContext surfaces views, hook rate, comments, and the channel baseline', () => {
  var ctx = buildPerformanceContext({ views: 500, hookRate: 0.42, comments: 12 }, { avg_views: 300, sample_size: 10 });
  assert.deepEqual(ctx, { views: 500, yt_hook_rate: 0.42, comments: 12, channel_baseline: { avg_views: 300, sample_size: 10 } });
});

test('sortForAnalysis puts today\'s video(s) first regardless of view count', () => {
  var rows = [
    { pageId: 'old-high-views', postDate: '2026-08-01', views: 9000 },
    { pageId: 'today-low-views', postDate: '2026-08-09', views: 10 }
  ];
  var sorted = sortForAnalysis(rows, '2026-08-09');
  assert.deepEqual(sorted.map((r) => r.pageId), ['today-low-views', 'old-high-views']);
});

test('sortForAnalysis orders the backlog (non-today rows) by views descending', () => {
  var rows = [
    { pageId: 'low', postDate: '2026-08-01', views: 100 },
    { pageId: 'high', postDate: '2026-08-02', views: 9000 },
    { pageId: 'mid', postDate: '2026-08-03', views: 500 }
  ];
  var sorted = sortForAnalysis(rows, '2026-08-09');
  assert.deepEqual(sorted.map((r) => r.pageId), ['high', 'mid', 'low']);
});

test('sortForAnalysis treats missing views as lowest priority, not highest', () => {
  var rows = [
    { pageId: 'no-views', postDate: '2026-08-01', views: null },
    { pageId: 'some-views', postDate: '2026-08-02', views: 1 }
  ];
  var sorted = sortForAnalysis(rows, '2026-08-09');
  assert.deepEqual(sorted.map((r) => r.pageId), ['some-views', 'no-views']);
});

test('sortForAnalysis does not mutate the input array', () => {
  var rows = [{ pageId: 'a', postDate: '2026-08-01', views: 1 }, { pageId: 'b', postDate: '2026-08-09', views: 2 }];
  var original = rows.slice();
  sortForAnalysis(rows, '2026-08-09');
  assert.deepEqual(rows, original);
});

test('filterByDateRange keeps only rows with postDate inside the inclusive [from, to] range', () => {
  var rows = [
    { pageId: 'june', postDate: '2026-06-30' },
    { pageId: 'july-start', postDate: '2026-07-01' },
    { pageId: 'august-end', postDate: '2026-08-31' },
    { pageId: 'september', postDate: '2026-09-01' }
  ];
  var filtered = filterByDateRange(rows, '2026-07-01', '2026-08-31');
  assert.deepEqual(filtered.map((r) => r.pageId), ['july-start', 'august-end']);
});

test('filterByDateRange drops rows with no postDate', () => {
  var rows = [{ pageId: 'no-date' }, { pageId: 'dated', postDate: '2026-07-15' }];
  assert.deepEqual(filterByDateRange(rows, '2026-07-01', '2026-08-31').map((r) => r.pageId), ['dated']);
});

test('filterByDateRange treats a missing from or to as an open bound', () => {
  var rows = [{ pageId: 'old', postDate: '2020-01-01' }, { pageId: 'new', postDate: '2030-01-01' }];
  assert.deepEqual(filterByDateRange(rows, '2025-01-01', undefined).map((r) => r.pageId), ['new']);
  assert.deepEqual(filterByDateRange(rows, undefined, '2025-01-01').map((r) => r.pageId), ['old']);
});
