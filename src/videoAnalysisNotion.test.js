import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisProps, buildExtractionOnlyProps, buildPerformanceContext, computeChannelBaseline } from './videoAnalysisNotion.js';

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
