import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadOne } from './downloader.js';

var CONCURRENCY = 2;

var jobs = new Map();

function broadcast(job, event) {
  var payload = 'data: ' + JSON.stringify(event) + '\n\n';
  job.listeners.forEach(function (res) { res.write(payload); });
}

function publicItem(item) {
  return {
    id: item.id,
    url: item.url,
    status: item.status,
    percent: item.percent,
    title: item.title,
    error: item.error
  };
}

async function runQueue(job) {
  var queue = job.items.slice();
  var workers = [];
  for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());

  async function worker() {
    var item;
    while ((item = queue.shift())) {
      item.status = 'downloading';
      console.log('[' + job.id.slice(0, 8) + '] downloading: ' + item.url);
      broadcast(job, { type: 'item', item: publicItem(item) });
      try {
        var result = await downloadOne(item.url, job.dir, function (progress) {
          if (typeof progress.percent === 'number') item.percent = progress.percent;
          if (progress.title) item.title = progress.title;
          broadcast(job, { type: 'item', item: publicItem(item) });
        });
        item.status = 'done';
        item.percent = 100;
        item.title = result.title;
        item.filepath = result.filepath;
        console.log('[' + job.id.slice(0, 8) + '] done: ' + item.title);
      } catch (err) {
        item.status = 'error';
        item.error = err.message;
        console.log('[' + job.id.slice(0, 8) + '] FAILED (' + item.url + '): ' + err.message);
      }
      broadcast(job, { type: 'item', item: publicItem(item) });
    }
  }

  await Promise.all(workers);
  job.finished = true;
  console.log('[' + job.id.slice(0, 8) + '] job finished: ' + job.items.filter(function (i) { return i.status === 'done'; }).length + '/' + job.items.length + ' succeeded');
  broadcast(job, { type: 'job-done' });
}

export function createJob(urls, baseDownloadsDir) {
  var id = crypto.randomUUID();
  var dir = path.join(baseDownloadsDir, id);
  fs.mkdirSync(dir, { recursive: true });

  var job = {
    id: id,
    dir: dir,
    finished: false,
    listeners: new Set(),
    items: urls.map(function (url) {
      return { id: crypto.randomUUID(), url: url, status: 'queued', percent: 0, title: null, filepath: null, error: null };
    })
  };
  jobs.set(id, job);
  console.log('[' + id.slice(0, 8) + '] job started: ' + urls.length + ' url(s)');
  runQueue(job).catch(function (err) {
    job.finished = true;
    broadcast(job, { type: 'job-error', error: err.message });
  });
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function jobSnapshot(job) {
  return { id: job.id, finished: job.finished, items: job.items.map(publicItem) };
}

export function addListener(job, res) {
  job.listeners.add(res);
}

export function removeListener(job, res) {
  job.listeners.delete(res);
}
