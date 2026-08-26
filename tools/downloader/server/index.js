import express from 'express';
import archiver from 'archiver';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createJob, getJob, jobSnapshot, addListener, removeListener } from './jobs.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PUBLIC_DIR = path.join(__dirname, '..', 'public');
var DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
var PORT = process.env.PORT || 4173;
var MAX_URLS_PER_JOB = 50;

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

var app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Recognized without a scheme so a bare address-bar copy (browsers hide
// "https://") or a "www.foo.com/..." paste isn't silently dropped below.
var KNOWN_DOMAINS = /^(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|instagram\.com|youtube\.com|youtu\.be|m\.youtube\.com|facebook\.com|fb\.watch|m\.facebook\.com)\b/i;

function normalizeLine(rawLine) {
  var line = String(rawLine || '').trim();
  if (!line) return '';
  // strip a leading bullet/dash/number ("- ", "* ", "1. ", "1) ") from pasted lists
  line = line.replace(/^(?:[-*•–—]|\d+[.)])\s+/, '').trim();
  if (line && !/^https?:\/\//i.test(line) && KNOWN_DOMAINS.test(line)) {
    line = 'https://' + line;
  }
  return line;
}

// Returns { urls, skipped } instead of silently dropping lines - every
// pasted line either becomes a download or a reported reason why not.
function parseUrls(raw) {
  if (!Array.isArray(raw)) return { urls: [], skipped: [] };
  var seen = new Set();
  var urls = [];
  var skipped = [];
  raw.forEach(function (rawLine) {
    var original = String(rawLine || '').trim();
    if (!original) return;
    var normalized = normalizeLine(original);
    if (!normalized || !/^https?:\/\//i.test(normalized)) {
      skipped.push({ line: original, reason: 'not a recognized URL' });
      return;
    }
    if (seen.has(normalized)) {
      skipped.push({ line: original, reason: 'duplicate' });
      return;
    }
    seen.add(normalized);
    urls.push(normalized);
  });
  return { urls: urls, skipped: skipped };
}

app.get('/api/default-path', function (req, res) {
  res.json({ path: DOWNLOADS_DIR });
});

app.post('/api/jobs', function (req, res) {
  var parsed = parseUrls(req.body && req.body.urls);
  var urls = parsed.urls;
  if (!urls.length) return res.status(400).json({ error: 'No valid http(s) URLs supplied.', skipped: parsed.skipped });
  if (urls.length > MAX_URLS_PER_JOB) return res.status(400).json({ error: 'Too many URLs (max ' + MAX_URLS_PER_JOB + ' per batch).' });

  var targetDir = DOWNLOADS_DIR;
  if (req.body && typeof req.body.path === 'string' && req.body.path.trim()) {
    targetDir = path.resolve(req.body.path.trim());
  }

  var job;
  try {
    job = createJob(urls, targetDir);
  } catch (err) {
    return res.status(400).json({ error: 'Could not create/write to that folder: ' + err.message });
  }
  var snapshot = jobSnapshot(job);
  snapshot.skipped = parsed.skipped;
  res.json(snapshot);
});

app.get('/api/jobs/:id', function (req, res) {
  var job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(jobSnapshot(job));
});

app.get('/api/jobs/:id/events', function (req, res) {
  var job = getJob(req.params.id);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('data: ' + JSON.stringify({ type: 'snapshot', job: jobSnapshot(job) }) + '\n\n');

  addListener(job, res);
  req.on('close', function () { removeListener(job, res); });
});

app.get('/api/jobs/:id/files/:itemId', function (req, res) {
  var job = getJob(req.params.id);
  if (!job) return res.status(404).end();
  var item = job.items.find(function (i) { return i.id === req.params.itemId; });
  if (!item || item.status !== 'done' || !item.filepath) return res.status(404).end();
  res.download(item.filepath);
});

app.get('/api/jobs/:id/zip', function (req, res) {
  var job = getJob(req.params.id);
  if (!job) return res.status(404).end();
  var done = job.items.filter(function (i) { return i.status === 'done' && i.filepath; });
  if (!done.length) return res.status(404).json({ error: 'No completed files yet.' });

  res.attachment('downloads.zip');
  var archive = archiver('zip');
  archive.on('error', function (err) { res.status(500).end(String(err)); });
  archive.pipe(res);
  done.forEach(function (item) { archive.file(item.filepath, { name: path.basename(item.filepath) }); });
  archive.finalize();
});

function checkTool(cmd) {
  var result = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !result.error;
}

function openBrowser(url) {
  var platform = process.platform;
  var child;
  if (platform === 'darwin') child = spawn('open', [url], { stdio: 'ignore', detached: true });
  else if (platform === 'win32') child = spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
  else child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  child.on('error', function () {}); // best-effort only, e.g. no GUI/xdg-open on headless boxes
  child.unref();
}

app.listen(PORT, function () {
  var url = 'http://localhost:' + PORT;
  console.log('Social downloader running at ' + url);

  if (!checkTool('yt-dlp')) console.log('WARNING: yt-dlp not found on PATH. Install it with "pip install -U yt-dlp".');
  if (!checkTool('ffmpeg')) console.log('WARNING: ffmpeg not found on PATH. 1080p downloads that need merging (mainly YouTube) will fail without it.');

  openBrowser(url);
});
