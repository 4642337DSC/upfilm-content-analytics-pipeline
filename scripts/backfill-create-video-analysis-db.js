import { getConfig, NOTION_VERSION } from '../src/config.js';
import { fetchJson } from '../src/http.js';

// One-time setup: creates the "Video Analysis" Notion database - one row
// per video per pipeline version (see docs/README section on the video
// analysis pipeline). Nested alongside the existing Video DB
// (NOTION_DATABASE_ID), same parent-resolution approach as
// backfill-create-daily-views-db.js, so it inherits the same integration
// access without needing a new page to be shared manually.
//
// Run once via the "Manual backfill" GitHub Action (or locally with
// `node --env-file=.env scripts/backfill-create-video-analysis-db.js`),
// then save the printed ID as VIDEO_ANALYSIS_DATABASE_ID (repo secret +
// local .env). Safe to re-run - it just creates another database each
// time, so don't run it twice.
var cfg = getConfig();
if (!cfg.NOTION_TOKEN) throw new Error('Set NOTION_TOKEN first.');
if (!cfg.NOTION_DATABASE_ID) throw new Error('Set NOTION_DATABASE_ID first - the new database relates back to it and is nested alongside it.');

var headers = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer ' + cfg.NOTION_TOKEN,
  'Notion-Version': NOTION_VERSION
};

var existing = await fetchJson('https://api.notion.com/v1/databases/' + cfg.NOTION_DATABASE_ID, { headers: headers });
if (existing.object === 'error') throw new Error('Could not read the Video database: ' + existing.message);
console.log('Video DB parent: ' + JSON.stringify(existing.parent));

// The create-database endpoint only accepts a page_id/database_id/workspace
// parent - not block_id, which is what the Video DB actually has if it's
// nested inside some block on a page. Walk up the block's own parent chain
// until we hit something the API will accept.
var parent = existing.parent;
while (parent.type === 'block_id') {
  var block = await fetchJson('https://api.notion.com/v1/blocks/' + parent.block_id, { headers: headers });
  if (block.object === 'error') throw new Error('Could not resolve parent block: ' + block.message);
  console.log('Resolved block parent: ' + JSON.stringify(block.parent));
  parent = block.parent;
}

var body = {
  parent: parent,
  icon: { type: 'emoji', emoji: '🎬' },
  title: [{ type: 'text', text: { content: 'Video Analysis' } }],
  properties: {
    Name: { title: {} },
    Video: {
      relation: {
        database_id: cfg.NOTION_DATABASE_ID,
        single_property: {}
      }
    },
    'Hook Score': { number: {} },
    'Structure Score': { number: {} },
    'Format Score': { number: {} },
    'Pacing Score': { number: {} },
    'CTA Score': { number: {} },
    'Overall Notes': { rich_text: {} },
    'Reusable Pattern': { rich_text: {} },
    'Raw Extraction': { rich_text: {} },
    // Set true by extraction-only rows (npm run analyze:extract, no
    // ANTHROPIC_API_KEY needed) and cleared once a Claude Code agent session
    // scores the row directly against Notion - see
    // prompts/videoAnalysisScoringAgentTask.md.
    'Needs Scoring': { checkbox: {} },
    'Analyzed Date': { date: {} },
    'Pipeline Version': {
      select: {
        options: [
          { name: 'v1-gemini-only', color: 'gray' },
          { name: 'v2-gemini-claude', color: 'green' }
        ]
      }
    }
  }
};

var created = await fetchJson('https://api.notion.com/v1/databases', {
  method: 'POST',
  headers: headers,
  body: JSON.stringify(body)
});

if (created.object === 'error') {
  console.error('Database creation failed: ' + created.message);
  console.error('If this is a permissions error, share the parent page with the Notion integration used for NOTION_TOKEN (Notion: "..." -> Connections on that page), then re-run.');
  process.exitCode = 1;
} else {
  console.log('Created "Video Analysis" database.');
  console.log('VIDEO_ANALYSIS_DATABASE_ID=' + created.id);
}
