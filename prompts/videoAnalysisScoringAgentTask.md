# Video analysis - Stage 2 scoring (Claude Code agent session)

This is the runbook for scoring videos **without** an `ANTHROPIC_API_KEY` -
instead of `src/claudeScore.js` calling the Messages API, a live Claude Code
agent session (this account's own Claude access, not a metered API key) does
the scoring itself and writes straight to Notion.

Run `npm run analyze:extract` first (needs `GEMINI_API_KEY` only) - that
does Stage 1 and leaves each video's Video Analysis row with `Raw Extraction`
filled in and `Needs Scoring` checked. This runbook is Stage 2 against those
rows.

## What to do

1. Find `VIDEO_ANALYSIS_DATABASE_ID` (from `.env` / repo secrets) and the
   target `PIPELINE_VERSION` (default `v2-gemini-claude`).
2. Query that database for rows where `Pipeline Version` equals the target
   version and `Needs Scoring` is checked.
3. For each row:
   - Read its `Raw Extraction` property (the Stage 1 JSON - validate it
     roughly matches `schemas/videoAnalysisRawExtraction.schema.json`; if a
     row's JSON is truncated or malformed, skip it and note why instead of
     guessing at missing data).
   - Follow the linked `Video` relation back to the source row in the Video
     DB (`NOTION_DATABASE_ID`) and read its performance properties: `Total
     Views` (formula), `YT Hook Rate`, `YT Comments` (or whatever
     `VIEWS_FIELD_NAME` / `HOOK_RATE_FIELD_NAME` / `COMMENTS_FIELD_NAME`
     are set to in `.env`).
   - Compute (or ask for) a channel baseline: average `Total Views` across
     all Video DB rows that have a views number, so scoring judges each
     video relative to its own channel rather than an absolute number.
   - Get brand context: use `BRAND_CONTEXT` from `.env` if set; otherwise
     ask the user for one paragraph, or pull it from wherever the client's
     brand description already lives in Notion.
   - Apply the exact rubric in `prompts/videoAnalysisClaudeScoring.txt` -
     read that file and follow it verbatim (five categories 1-10: hook,
     structure, format, pacing, cta; each needs `score`, `reasoning`, and
     `evidence_timestamps` grounded in the raw extraction's actual
     timestamps, never invented ones; plus `overall_notes` and
     `reusable_pattern`). The output shape must match
     `schemas/videoAnalysisScoring.schema.json`.
   - Update the row's properties directly:
     - `Hook Score`, `Structure Score`, `Format Score`, `Pacing Score`,
       `CTA Score` (numbers, 1-10)
     - `Overall Notes`, `Reusable Pattern` (text)
     - `Needs Scoring` -> unchecked
     - `Analyzed Date` -> now
4. Report a short summary at the end: how many rows scored, how many
   skipped and why.

## Notes

- This is a manual/on-demand pass by default - run it whenever there's a
  backlog of `Needs Scoring` rows. If you want it automatic, a Claude Code
  Routine can fire this same runbook on a schedule (ask for that
  separately - it consumes usage under this account's plan on every
  firing, unlike the free-to-configure cron/GitHub Actions path used for
  the rest of this repo's sync).
- Score independently per video - don't let one video's rating anchor the
  next one's.
- If `src/videoAnalysisValidate.js` (`npm run analyze:validate`) is later
  run to A/B this pipeline version against `v1-gemini-only`, scores written
  this way are exactly as eligible as scores written via `scoreVideo()` -
  same schema, same DB, same `Pipeline Version` tag.
