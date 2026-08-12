import fs from 'node:fs/promises';
import path from 'node:path';

async function loadFontFace() {
  var templatePath = new URL('../templates/DashboardTemplate.html', import.meta.url);
  var dashboardHtml = await fs.readFile(templatePath, 'utf8');
  var match = dashboardHtml.match(/@font-face\s*\{[\s\S]*?\}/);
  return match ? match[0] : '';
}

// Copies the shared brand assets (assets/report/*) into
// dist/clients/<client>/reports/assets/ - a plain file copy, not embedded
// as base64, since these are static images shared by the one report page
// rather than something that needs to travel inside a portable HTML file
// (unlike the font, which is spliced in from DashboardTemplate.html).
// Upfilm's own logo is shared by every client; the left badge is each
// client's own logo, expected at assets/report/<slug>-logo.(svg|png) - not
// every client has supplied one yet, so this returns the HTML for that
// badge (an <img> tag, or '' to leave it empty) rather than assuming the
// file exists. Both extensions are tried since clients supply logos in
// whatever format they have on hand (Isogreen: svg, Miradex: a
// background-removed png).
var CLIENT_LOGO_EXTENSIONS = ['svg', 'png'];

async function copyReportAssets(cfg, outDir) {
  var assetsDir = path.join(outDir, 'reports', 'assets');
  await fs.mkdir(assetsDir, { recursive: true });
  var srcDir = new URL('../assets/report/', import.meta.url);
  await fs.copyFile(new URL('upfilm-logo-transparent.png', srcDir), path.join(assetsDir, 'upfilm-logo-transparent.png'));

  for (var ext of CLIENT_LOGO_EXTENSIONS) {
    var clientLogoFile = cfg.CLIENT_SLUG + '-logo.' + ext;
    try {
      await fs.copyFile(new URL(clientLogoFile, srcDir), path.join(assetsDir, clientLogoFile));
      return '<img src="assets/' + clientLogoFile + '" alt="' + cfg.CLIENT_NAME + '">';
    } catch (e) { /* try the next extension */ }
  }
  console.log('No report logo for client "' + cfg.CLIENT_SLUG + '" (expected assets/report/' + cfg.CLIENT_SLUG + '-logo.{svg,png}) - left badge left empty.');
  return '';
}

// Where the report page's "materials" footer link points, per client.
// Isogreen has always had one evergreen folder for everything ("static").
// Miradex organizes source footage into per-month Drive subfolders instead
// (only 2026's folders exist so far - other months simply won't show a
// link, see MATERIALS_LINKS handling in ReportTemplate.html's render()).
var MATERIALS_LINKS = {
  isogreen: { static: 'https://drive.google.com/open?id=1iG3hui_QPBj9qK22AVFlbywQZzq2YjC8&usp=drive_fs' },
  miradex: {
    byMonth: {
      '2026-01': '1uTLUcZEOMelCCBMlgpiiicPOk4mi8tyk',
      '2026-02': '1LTlAUmzg8IIyCQKKEQmem4y8u5w-sBHG',
      '2026-03': '1tuwwlmuJ2WxmjXZbMmrLnrhKi7x-7BQE',
      '2026-04': '1y2eHWJSaUKcgcoByuCPgLXPIxj19aN-m',
      '2026-05': '17hUinrsUybgvGsTbRBHihzxkdk4rL_Tw',
      '2026-06': '1j5H3wVkFLMSxj0n6v3E97NrsjNs8ctWG',
      '2026-07': '1lDsBhFRDyv2qjYbrc813gCn4Tdzbjp7h',
      '2026-08': '1XDmMGtGA8iD6z8vIOEP5UFnidex2nyqt',
      '2026-09': '1Al_EI77ly2CtfZLMt7viBjKSVR57SzEb',
      '2026-10': '1cZpefmjllhXUQnyjOcBDXUxQmQTRA_Gb',
      '2026-11': '1LS2VIsbFExsd_8TjIQRg6FBwz2n53gov',
      '2026-12': '18mCm5s0PlVu79LyiP8K1uYllb_lcn8fK'
    }
  }
};

// Builds the single Reports app page
// (dist/clients/<client>/reports/index.html) - a self-contained page that
// embeds every month's data (same rows/monthly/followerSnapshots
// buildDashboard already fetched) plus a year/month picker, and renders
// the report entirely client-side when a month is selected. Rebuilt on
// every sync, same as the dashboard itself - it's just one lightweight
// data-embedding page, not a per-month pre-render, so there's nothing to
// overwrite or go stale between syncs.
export async function buildReportsApp(cfg, data, outDir) {
  var clientLogoBadge = await copyReportAssets(cfg, outDir);
  var fontFace = await loadFontFace();
  var templatePath = new URL('../templates/ReportTemplate.html', import.meta.url);
  var template = await fs.readFile(templatePath, 'utf8');

  var html = template
    .replace('/*__FONT_FACE__*/', fontFace)
    .replace('/*__RAW_DATA__*/', JSON.stringify(data.rows))
    .replace('/*__MONTHLY_VIEWS_DATA__*/', JSON.stringify(data.monthly))
    .replace('/*__FOLLOWER_SNAPSHOTS_DATA__*/', JSON.stringify(data.followerSnapshots))
    .replace('/*__LONG_FORM_DATA__*/', JSON.stringify(data.longFormRows || []))
    .replace('/*__CLIENT_LOGO_BADGE__*/', clientLogoBadge)
    .replace('/*__MATERIALS_LINKS_DATA__*/', JSON.stringify(MATERIALS_LINKS[cfg.CLIENT_SLUG] || {}))
    .split('__CLIENT_NAME__').join(cfg.CLIENT_NAME);

  var reportsDir = path.join(outDir, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.join(reportsDir, 'index.html'), html, 'utf8');
  console.log('Reports app written to ' + path.join(reportsDir, 'index.html'));
}
