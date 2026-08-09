import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, toGeminiSchema, validate } from './videoAnalysisSchema.js';

var validExtraction = {
  video_id: 'abc123',
  duration_seconds: 12.5,
  hook_window: { visual_description: 'x', spoken_words: 'y', cut_count_in_window: 2 },
  segments: [
    { start_sec: 0, end_sec: 2, shot_type: 'talking_head', visual_description: 'x', spoken_words: 'y' }
  ],
  cut_stats: { total_cuts: 5, avg_shot_length_sec: 2.5, talking_head_ratio: 0.6 },
  structural_markers: { payoff_timestamp_sec: 4, cta_timestamp_sec: null, cta_text: null, topic_changes: [] }
};

test('validate() accepts a well-formed raw extraction', () => {
  var errors = validate(loadSchema('videoAnalysisRawExtraction'), validExtraction);
  assert.deepEqual(errors, []);
});

test('validate() flags a missing required top-level field', () => {
  var broken = { ...validExtraction };
  delete broken.cut_stats;
  var errors = validate(loadSchema('videoAnalysisRawExtraction'), broken);
  assert.ok(errors.some((e) => e.includes('cut_stats')));
});

test('validate() flags a missing required nested field', () => {
  var broken = { ...validExtraction, hook_window: { visual_description: 'x' } };
  var errors = validate(loadSchema('videoAnalysisRawExtraction'), broken);
  assert.ok(errors.some((e) => e.includes('spoken_words')));
});

test('validate() flags a wrong type', () => {
  var broken = { ...validExtraction, duration_seconds: 'twelve' };
  var errors = validate(loadSchema('videoAnalysisRawExtraction'), broken);
  assert.ok(errors.some((e) => e.includes('duration_seconds')));
});

test('validate() flags an enum violation on segment shot_type', () => {
  var broken = {
    ...validExtraction,
    segments: [{ start_sec: 0, end_sec: 2, shot_type: 'drone_shot', visual_description: 'x', spoken_words: 'y' }]
  };
  var errors = validate(loadSchema('videoAnalysisRawExtraction'), broken);
  assert.ok(errors.some((e) => e.includes('drone_shot')));
});

test('validate() accepts null for a nullable field and rejects null for a required one', () => {
  var errors = validate(loadSchema('videoAnalysisRawExtraction'), validExtraction);
  assert.deepEqual(errors, []);

  var broken = { ...validExtraction, video_id: null };
  var brokenErrors = validate(loadSchema('videoAnalysisRawExtraction'), broken);
  assert.ok(brokenErrors.some((e) => e.includes('video_id')));
});

var validScoring = {
  video_id: 'abc123',
  scores: {
    hook: { score: 7, reasoning: 'r', evidence_timestamps: [1.2] },
    structure: { score: 6, reasoning: 'r', evidence_timestamps: [] },
    format: { score: 8, reasoning: 'r', evidence_timestamps: [] },
    pacing: { score: 5, reasoning: 'r', evidence_timestamps: [] },
    cta: { score: 4, reasoning: 'r', evidence_timestamps: [] }
  },
  overall_notes: 'notes',
  performance_notes: 'why it performed the way it did',
  reusable_pattern: ''
};

test('validate() accepts a well-formed scoring result, including $ref/$defs resolution', () => {
  var errors = validate(loadSchema('videoAnalysisScoring'), validScoring);
  assert.deepEqual(errors, []);
});

test('validate() flags a score outside 1-10 via minimum/maximum', () => {
  var broken = { ...validScoring, scores: { ...validScoring.scores, hook: { score: 11, reasoning: 'r', evidence_timestamps: [] } } };
  var errors = validate(loadSchema('videoAnalysisScoring'), broken);
  assert.ok(errors.some((e) => e.includes('maximum')));
});

test('toGeminiSchema() converts nullable unions and inlines $refs, dropping $ref/$defs', () => {
  var gemini = toGeminiSchema(loadSchema('videoAnalysisRawExtraction'));
  assert.equal(gemini.properties.structural_markers.properties.payoff_timestamp_sec.type, 'number');
  assert.equal(gemini.properties.structural_markers.properties.payoff_timestamp_sec.nullable, true);
  assert.equal(JSON.stringify(gemini).includes('$ref'), false);

  var geminiScoring = toGeminiSchema(loadSchema('videoAnalysisScoring'));
  assert.equal(geminiScoring.properties.scores.properties.hook.type, 'object');
  assert.equal(geminiScoring.properties.scores.properties.hook.properties.score.type, 'integer');
});
