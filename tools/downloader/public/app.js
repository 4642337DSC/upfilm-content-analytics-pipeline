var urlsEl = document.getElementById('urls');
var startBtn = document.getElementById('start');
var errorEl = document.getElementById('error');
var resultsEl = document.getElementById('results');
var itemsEl = document.getElementById('items');
var zipEl = document.getElementById('zip');

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

function startJob() {
  errorEl.textContent = '';
  var urls = urlsEl.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!urls.length) {
    errorEl.textContent = 'Paste at least one URL.';
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = 'Starting...';

  fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: urls })
  })
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || 'Request failed.');
        return body;
      });
    })
    .then(function (job) {
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
      startBtn.disabled = false;
      startBtn.textContent = 'Download';
    });
}

startBtn.addEventListener('click', startJob);
