import { getConfig, requireConfig } from '../src/config.js';
import { queryNotionDatabase, updateNotionPage } from '../src/notion.js';

// Per Stefan: flip every Darcom row's Tip to Short so the regular
// Shorts-only sync (buildShortsFilter) actually picks up every row and
// writes real view counts, instead of the 12 long-form rows sitting at 0
// because they're invisible to the Tip=Short-filtered query. This doesn't
// undo the duration data already recorded (Duration (s) still shows the
// real length) - it only changes which sync pass touches the row.

var cfg = getConfig();
requireConfig(cfg);

async function fetchAllRows(cfg) {
  var rows = [];
  var cursor = null;
  do {
    var payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    var data = await queryNotionDatabase(cfg, cfg.NOTION_DATABASE_ID, payload);
    if (data.object === 'error') throw new Error('Notion query failed: ' + data.message);
    (data.results || []).forEach(function (page) {
      var props = page.properties;
      var name = (props['Name'].title || []).map(function (t) { return t.plain_text; }).join('');
      rows.push({
        pageId: page.id,
        name: name,
        tip: props['Tip'] && props['Tip'].select ? props['Tip'].select.name : null
      });
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

var rows = await fetchAllRows(cfg);
var toFlip = rows.filter(function (r) { return r.tip && r.tip !== 'Short'; });
console.log(rows.length + ' total rows, ' + toFlip.length + ' not currently Short.');

for (var r of toFlip) {
  await updateNotionPage(cfg, r.pageId, { 'Tip': { select: { name: 'Short' } } });
  console.log('  Set Short: ' + r.name + ' (was ' + r.tip + ')');
}
console.log('\nDone.');
