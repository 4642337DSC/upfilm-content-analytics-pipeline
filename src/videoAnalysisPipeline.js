import { getConfig, requireVideoAnalysisConfig, requireVideoAnalysisExtractionConfig } from './config.js';
import { extractVideo } from './geminiExtract.js';
import { scoreVideo } from './claudeScore.js';
import {
  buildPerformanceContext,
  computeChannelBaseline,
  fetchAllVideoRows,
  fetchVideosNeedingAnalysis,
  writeAnalysisResult,
  writeExtractionOnly
} from './videoAnalysisNotion.js';

// Thin orchestrator: for each video needing analysis, extract (Stage 1,
// cache-aware) -> score (Stage 2) -> write to Notion. Safe to re-run - a
// partial failure on one video is logged and skipped, not thrown, so a
// crash mid-run doesn't require manual cleanup; the next run picks up
// wherever fetchVideosNeedingAnalysis says work remains.
//
// Requires ANTHROPIC_API_KEY (scoreVideo() calls the Messages API directly).
// If you'd rather not pay for a separate API key, use runExtraction()
// instead and have a live Claude Code agent session do the scoring against
// Notion - see prompts/videoAnalysisScoringAgentTask.md.
export async function runPipeline(options) {
  options = options || {};
  var cfg = getConfig();
  requireVideoAnalysisConfig(cfg);

  var allRows = await fetchAllVideoRows(cfg);
  var channelBaseline = computeChannelBaseline(allRows);
  var pending = await fetchVideosNeedingAnalysis(cfg, cfg.PIPELINE_VERSION, allRows);
  if (options.limit) pending = pending.slice(0, options.limit);

  console.log('Video analysis pipeline (' + cfg.PIPELINE_VERSION + '): ' + pending.length + ' video(s) to process.');

  var succeeded = 0;
  var failed = [];

  for (var row of pending) {
    var videoId = row.pageId;
    try {
      console.log('[' + videoId + '] ' + (row.name || '(untitled)') + ': extracting (Gemini, from ' + row.youtubeUrl + ')...');
      var extracted = await extractVideo(cfg, { videoId: videoId, youtubeUrl: row.youtubeUrl });
      if (extracted.fromCache) console.log('[' + videoId + '] using cached extraction.');

      console.log('[' + videoId + '] scoring (Claude)...');
      var performance = buildPerformanceContext(row, channelBaseline);
      var analysis = await scoreVideo(cfg, {
        videoId: videoId,
        rawExtraction: extracted.extraction,
        performance: performance,
        brandContext: cfg.BRAND_CONTEXT
      });

      console.log('[' + videoId + '] writing to Notion...');
      await writeAnalysisResult(cfg, {
        videoPageId: row.pageId,
        videoName: row.name,
        analysis: analysis,
        rawExtraction: extracted.extraction,
        pipelineVersion: cfg.PIPELINE_VERSION
      });

      succeeded++;
      console.log('[' + videoId + '] done.');
    } catch (err) {
      console.log('[' + videoId + '] FAILED: ' + (err && err.message ? err.message : err));
      failed.push({ videoId: videoId, name: row.name, error: err && err.message ? err.message : String(err) });
      if (err && err.quotaExhausted) {
        console.log('Gemini quota/billing exhausted - stopping run early instead of retrying it against every remaining video.');
        break;
      }
    }
  }

  console.log('Video analysis pipeline finished: ' + succeeded + ' succeeded, ' + failed.length + ' failed.');
  if (failed.length) {
    failed.forEach(function (f) { console.log('  - [' + f.videoId + '] ' + f.name + ': ' + f.error); });
  }
  return { succeeded: succeeded, failed: failed };
}

// Stage 1 only - no ANTHROPIC_API_KEY needed. Writes each raw extraction to
// its Video Analysis row flagged "Needs Scoring", for a Claude Code agent
// session to score directly against Notion afterward (see
// prompts/videoAnalysisScoringAgentTask.md). Same cache-aware,
// re-run-safe shape as runPipeline.
export async function runExtraction(options) {
  options = options || {};
  var cfg = getConfig();
  requireVideoAnalysisExtractionConfig(cfg);

  var allRows = await fetchAllVideoRows(cfg);
  var pending = await fetchVideosNeedingAnalysis(cfg, cfg.PIPELINE_VERSION, allRows);
  if (options.limit) pending = pending.slice(0, options.limit);

  console.log('Video analysis extraction (' + cfg.PIPELINE_VERSION + '): ' + pending.length + ' video(s) to process.');

  var succeeded = 0;
  var failed = [];

  for (var row of pending) {
    var videoId = row.pageId;
    try {
      console.log('[' + videoId + '] ' + (row.name || '(untitled)') + ': extracting (Gemini, from ' + row.youtubeUrl + ')...');
      var extracted = await extractVideo(cfg, { videoId: videoId, youtubeUrl: row.youtubeUrl });
      if (extracted.fromCache) console.log('[' + videoId + '] using cached extraction.');

      console.log('[' + videoId + '] writing raw extraction to Notion (Needs Scoring)...');
      await writeExtractionOnly(cfg, {
        videoPageId: row.pageId,
        videoName: row.name,
        rawExtraction: extracted.extraction,
        pipelineVersion: cfg.PIPELINE_VERSION
      });

      succeeded++;
      console.log('[' + videoId + '] done.');
    } catch (err) {
      console.log('[' + videoId + '] FAILED: ' + (err && err.message ? err.message : err));
      failed.push({ videoId: videoId, name: row.name, error: err && err.message ? err.message : String(err) });
      if (err && err.quotaExhausted) {
        console.log('Gemini quota/billing exhausted - stopping run early instead of retrying it against every remaining video.');
        break;
      }
    }
  }

  console.log('Video analysis extraction finished: ' + succeeded + ' succeeded, ' + failed.length + ' failed.');
  if (failed.length) {
    failed.forEach(function (f) { console.log('  - [' + f.videoId + '] ' + f.name + ': ' + f.error); });
  }
  return { succeeded: succeeded, failed: failed };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  var limitArg = process.argv.find(function (a) { return a.startsWith('--limit='); });
  var limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;
  var run = process.argv.includes('--extract-only') ? runExtraction : runPipeline;
  run({ limit: limit }).then(function (result) {
    if (result.failed.length) process.exitCode = 1;
  });
}
