// Default BRAND_CONTEXT for the video analysis pipeline's Claude scoring
// step (see prompts/videoAnalysisClaudeScoring.txt) - overridable via env,
// but this repo is Isogreen-first (see CHANNEL_HANDLE/CLIENT_NAME above),
// so scoring works out of the box without anyone having to set it.
var ISOGREEN_BRAND_CONTEXT = 'ISOGREEN manufactures and installs blown cellulose insulation and mineral ' +
  '(basalt) wool flakes, primarily for wood-frame and metal-frame houses. The brand\'s mission is ' +
  'educating the public about sustainable, natural insulation solutions and energy efficiency. The ' +
  'audience has two segments: homeowners evaluating insulation options for their build, and ' +
  'professional installers/contractors who could purchase the product for their own installation ' +
  'business. Common topics include: how blown insulation fills gaps better than rigid panels, ' +
  'addressing common myths/objections (rodents, moisture, mold, fire risk), specific product lines ' +
  '(ISOFULG, ISOFIBER, ISODEPOT), installation team/process credibility, and energy-bill savings.';

export function getConfig() {
  return {
    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || null,
    NOTION_TOKEN: process.env.NOTION_TOKEN || null,
    NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID || null,
    CHANNEL_HANDLE: process.env.CHANNEL_HANDLE || '@isogreenromania',
    FB_PAGE_ID: process.env.FB_PAGE_ID || null,
    FB_PAGE_ACCESS_TOKEN: process.env.FB_PAGE_ACCESS_TOKEN || null,
    ZERNIO_API_KEY: process.env.ZERNIO_API_KEY || null,
    ZERNIO_TIKTOK_ACCOUNT_ID: process.env.ZERNIO_TIKTOK_ACCOUNT_ID || null,
    CHANNEL_STATS_DATABASE_ID: process.env.CHANNEL_STATS_DATABASE_ID || null,
    MONTHLY_VIEWS_DATABASE_ID: process.env.MONTHLY_VIEWS_DATABASE_ID || null,
    DAILY_VIEWS_DATABASE_ID: process.env.DAILY_VIEWS_DATABASE_ID || null,
    FOLLOWER_SNAPSHOTS_DATABASE_ID: process.env.FOLLOWER_SNAPSHOTS_DATABASE_ID || null,
    YOUTUBE_OAUTH_CLIENT_ID: process.env.YOUTUBE_OAUTH_CLIENT_ID || null,
    YOUTUBE_OAUTH_CLIENT_SECRET: process.env.YOUTUBE_OAUTH_CLIENT_SECRET || null,
    YOUTUBE_REFRESH_TOKEN: process.env.YOUTUBE_REFRESH_TOKEN || null,
    CLIENT_SLUG: process.env.CLIENT_SLUG || 'isogreen',
    CLIENT_NAME: process.env.CLIENT_NAME || 'ISOGREEN',
    NOTION_FILTER_TIP: process.env.NOTION_FILTER_TIP !== 'false',
    YT_FIELD_NAME: process.env.YT_FIELD_NAME || 'YouTube',
    FB_FIELD_NAME: process.env.FB_FIELD_NAME || 'Facebook',
    IG_FIELD_NAME: process.env.IG_FIELD_NAME || 'Instagram',
    TT_FIELD_NAME: process.env.TT_FIELD_NAME || 'TikTok',

    // --- Video analysis pipeline (Gemini extract -> Claude score -> Notion) ---
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
    VIDEO_ANALYSIS_DATABASE_ID: process.env.VIDEO_ANALYSIS_DATABASE_ID || null,
    // Matches the real ISOGREEN "Video" database's actual property names -
    // "Total Views" is a formula (sums all 4 platforms), "YT Hook Rate" is
    // what the original ρ=0.55 baseline was validated against.
    VIEWS_FIELD_NAME: process.env.VIEWS_FIELD_NAME || 'Total Views',
    HOOK_RATE_FIELD_NAME: process.env.HOOK_RATE_FIELD_NAME || 'YT Hook Rate',
    COMMENTS_FIELD_NAME: process.env.COMMENTS_FIELD_NAME || 'YT Comments',
    BRAND_CONTEXT: process.env.BRAND_CONTEXT || ISOGREEN_BRAND_CONTEXT,
    // Written to every Video Analysis row's "Pipeline Version" select, so
    // the v1-gemini-only baseline and this v2 pipeline can run side by side
    // on the same videos without overwriting each other (see Section 6 of
    // the build plan - A/B validation before flipping production over).
    PIPELINE_VERSION: process.env.PIPELINE_VERSION || 'v2-gemini-claude'
  };
}

export function requireConfig(cfg) {
  if (!cfg.YOUTUBE_API_KEY || !cfg.NOTION_TOKEN || !cfg.NOTION_DATABASE_ID) {
    throw new Error('Missing required env vars. Set YOUTUBE_API_KEY, NOTION_TOKEN, NOTION_DATABASE_ID (see .env.example).');
  }
}

// Stage 1 only - what npm run analyze:extract needs. Does not require
// ANTHROPIC_API_KEY: scoring either happens via scoreVideo() (if a key is
// set) or is left for a live Claude Code agent session to do directly
// against Notion (see prompts/videoAnalysisScoringAgentTask.md) - no API
// key needed for that path, since it runs on the account's own Claude
// access rather than a metered console.anthropic.com key.
export function requireVideoAnalysisExtractionConfig(cfg) {
  if (!cfg.GEMINI_API_KEY || !cfg.NOTION_TOKEN || !cfg.NOTION_DATABASE_ID || !cfg.VIDEO_ANALYSIS_DATABASE_ID) {
    throw new Error('Missing required env vars. Set GEMINI_API_KEY, NOTION_TOKEN, NOTION_DATABASE_ID, VIDEO_ANALYSIS_DATABASE_ID (see .env.example).');
  }
}

// Full API-driven pipeline (Stage 1 + Stage 2 scoreVideo() in one script
// run) - only needed if you have an ANTHROPIC_API_KEY and want scoring to
// happen unattended in the same run as extraction, e.g. from cron.
export function requireVideoAnalysisConfig(cfg) {
  requireVideoAnalysisExtractionConfig(cfg);
  if (!cfg.ANTHROPIC_API_KEY) {
    throw new Error('Missing ANTHROPIC_API_KEY. Either set it, or run `npm run analyze:extract` instead and score via a Claude Code agent session (see prompts/videoAnalysisScoringAgentTask.md).');
  }
}

export var NOTION_VERSION = '2022-06-28';
export var GRAPH_API_VERSION = 'v25.0';
export var TEXT_MATCH_THRESHOLD = 0.32;
export var TEXT_MARGIN = 0.06;
export var UNMATCHED_SUMMARY_CAP = 20;
