var urlsEl = document.getElementById('urls');
var pathEl = document.getElementById('path');
var pathHistoryEl = document.getElementById('path-history');
var startBtn = document.getElementById('start');
var errorEl = document.getElementById('error');
var skippedEl = document.getElementById('skipped');
var resultsEl = document.getElementById('results');
var itemsEl = document.getElementById('items');
var zipEl = document.getElementById('zip');

var PATH_HISTORY_KEY = 'downloader.pathHistory';
var PATH_HISTORY_MAX = 10;

function loadPathHistory() {
  try {
    var raw = localStorage.getItem(PATH_HISTORY_KEY);
    var list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function renderPathHistory(list) {
  pathHistoryEl.innerHTML = '';
  list.forEach(function (p) {
    var opt = document.createElement('option');
    opt.value = p;
    pathHistoryEl.appendChild(opt);
  });
}

function rememberPath(p) {
  if (!p) return;
  var list = loadPathHistory().filter(function (existing) { return existing !== p; });
  list.unshift(p);
  list = list.slice(0, PATH_HISTORY_MAX);
  try { localStorage.setItem(PATH_HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  renderPathHistory(list);
}

renderPathHistory(loadPathHistory());

fetch('/api/default-path')
  .then(function (res) { return res.json(); })
  .then(function (data) { if (data && data.path) pathEl.value = data.path; })
  .catch(function () {});

function statusLabel(item) {
  if (item.status === 'queued') return 'Queued';
  if (item.status === 'downloading') return Math.round(item.percent || 0) + '%';
  if (item.status === 'done') return 'Done';
  if (item.status === 'error') return 'Failed';
  return item.status;
}

function renderItem(jobId, item) {
  var li = document.getElementById('item-' + item.id);
  if (!li) {
    li = document.createElement('li');
    li.id = 'item-' + item.id;
    li.className = 'item';
    li.innerHTML =
      '<div class="item-row">' +
      '  <span class="item-title"></span>' +
      '  <span class="item-status"></span>' +
      '</div>' +
      '<div class="progress"><div class="progress-bar"></div></div>' +
      '<div class="item-error-msg"></div>';
    itemsEl.appendChild(li);
  }

  li.className = 'item item-' + item.status;
  li.querySelector('.item-title').textContent = item.title || item.url;
  li.querySelector('.item-status').textContent = statusLabel(item);
  li.querySelector('.progress-bar').style.width = (item.status === 'done' ? 100 : (item.percent || 0)) + '%';

  var errorRow = li.querySelector('.item-error-msg');
  errorRow.textContent = item.status === 'error' ? item.error : '';

  var titleEl = li.querySelector('.item-title');
  if (item.status === 'done') {
    titleEl.innerHTML = '';
    var a = document.createElement('a');
    a.href = '/api/jobs/' + jobId + '/files/' + item.id;
    a.textContent = item.title || item.url;
    a.download = '';
    titleEl.appendChild(a);
  }
}

function formatSkipped(skipped) {
  if (!skipped || !skipped.length) return '';
  return 'Skipped ' + skipped.length + ' line(s): ' +
    skipped.map(function (s) { return '"' + s.line + '" (' + s.reason + ')'; }).join(', ');
}

function startJob() {
  errorEl.textContent = '';
  skippedEl.hidden = true;
  skippedEl.textContent = '';
  var urls = urlsEl.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!urls.length) {
    errorEl.textContent = 'Paste at least one URL.';
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = 'Starting...';

  var chosenPath = pathEl.value.trim();

  fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: urls, path: chosenPath })
  })
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          var err = new Error(body.error || 'Request failed.');
          err.skipped = body.skipped;
          throw err;
        }
        return body;
      });
    })
    .then(function (job) {
      rememberPath(chosenPath);
      if (job.skipped && job.skipped.length) {
        skippedEl.hidden = false;
        skippedEl.textContent = formatSkipped(job.skipped);
      }
      itemsEl.innerHTML = '';
      resultsEl.hidden = false;
      zipEl.hidden = true;
      job.items.forEach(function (item) { renderItem(job.id, item); });

      var source = new EventSource('/api/jobs/' + job.id + '/events');
      source.onmessage = function (evt) {
        var msg = JSON.parse(evt.data);
        if (msg.type === 'snapshot') {
          msg.job.items.forEach(function (item) { renderItem(job.id, item); });
        } else if (msg.type === 'item') {
          renderItem(job.id, msg.item);
        } else if (msg.type === 'job-done') {
          zipEl.hidden = false;
          zipEl.href = '/api/jobs/' + job.id + '/zip';
          source.close();
          startBtn.disabled = false;
          startBtn.textContent = 'Download';
        } else if (msg.type === 'job-error') {
          errorEl.textContent = msg.error;
          source.close();
          startBtn.disabled = false;
          startBtn.textContent = 'Download';
        }
      };
      source.onerror = function () {
        source.close();
        startBtn.disabled = false;
        startBtn.textContent = 'Download';
      };
    })
    .catch(function (err) {
      errorEl.textContent = err.message;
      if (err.skipped && err.skipped.length) {
        skippedEl.hidden = false;
        skippedEl.textContent = formatSkipped(err.skipped);
      }
      startBtn.disabled = false;
      startBtn.textContent = 'Download';
    });
}

startBtn.addEventListener('click', startJob);
