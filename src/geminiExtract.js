import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText } from './http.js';
import { loadSchema, toGeminiSchema, validate } from './videoAnalysisSchema.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
var CACHE_DIR = path.join(__dirname, '..', 'cache');

var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
// gemini-2.5-flash (the model the original ρ=0.55 baseline was validated
// against) returns 404 "no longer available to new users" for any API key
// created after its cutoff - confirmed live via the first extraction run
// against a fresh GEMINI_API_KEY. gemini-3.6-flash is the current
// equivalent flash-tier model with the same fileData/fileUri video input
// support. This means the A/B validation in videoAnalysisValidate.js is no
// longer purely "architecture change, model held constant" - flag that
// when interpreting its results.
var GEMINI_MODEL = 'gemini-3.6-flash';

function extractionPrompt() {
  return fs.readFileSync(path.join(PROMPTS_DIR, 'videoAnalysisGeminiExtraction.txt'), 'utf8');
}

function cachePath(videoId) {
  return path.join(CACHE_DIR, videoId + '_raw.json');
}

export function readCachedExtraction(videoId) {
  var p = cachePath(videoId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeCachedExtraction(videoId, extraction) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(videoId), JSON.stringify(extraction, null, 2));
}

// Gemini can take a public YouTube URL directly in fileData.fileUri - no
// Files API upload/poll round-trip needed, unlike arbitrary video files.
// This only works for videos that are actually posted to YouTube (public or
// unlisted); TikTok/IG/FB-only videos aren't analyzable this way.
async function callGenerateContent(cfg, youtubeUrl, videoId) {
  var schema = toGeminiSchema(loadSchema('videoAnalysisRawExtraction'));
  var body = {
    contents: [{
      parts: [
        { fileData: { fileUri: youtubeUrl } },
        { text: extractionPrompt() + '\n\nvideo_id: ' + videoId }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };
  var res = await fetchText(
    GEMINI_API_BASE + '/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + cfg.GEMINI_API_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  var data = res.json();
  if (!data || !data.candidates || !data.candidates[0]) {
    throw new Error('Gemini generateContent returned no candidates: ' + res.text);
  }
  var text = data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('Gemini response was not valid JSON: ' + err.message + '\n' + text);
  }
  return parsed;
}

// Stage 1: YouTube URL -> raw_extraction.json, cached to disk per video_id so
// re-running the pipeline (or re-scoring in Stage 2 later) never re-pays for
// Gemini video tokens. Returns { extraction, fromCache }.
export async function extractVideo(cfg, options) {
  var videoId = options.videoId;
  var youtubeUrl = options.youtubeUrl;
  var force = !!options.force;

  if (!force) {
    var cached = readCachedExtraction(videoId);
    if (cached) return { extraction: cached, fromCache: true };
  }

  if (!cfg.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');

  var extraction = await callGenerateContent(cfg, youtubeUrl, videoId);

  var errors = validate(loadSchema('videoAnalysisRawExtraction'), extraction);
  if (errors.length) {
    throw new Error('Gemini extraction for "' + videoId + '" failed schema validation:\n' + errors.join('\n'));
  }

  writeCachedExtraction(videoId, extraction);
  return { extraction: extraction, fromCache: false };
}
