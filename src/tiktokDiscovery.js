import { spawn } from 'node:child_process';

// Zernio has no endpoint that lists a connected account's native TikTok
// history - GET /v1/posts only returns content scheduled through Zernio
// itself (see the comment on extractTikTokId in tiktok.js). This is the
// stopgap until TikTok's own Login Kit + video.list is wired up: it reads
// the account's public profile via yt-dlp instead. No login/cookies - pure
// anonymous read of public data, same as loading the profile in a browser.
// Requires yt-dlp's curl_cffi extra (`pip install -U "yt-dlp[default,curl-cffi]"`)
// - TikTok's user-listing endpoint rejects yt-dlp's plain HTTP client
// outright ("attempting impersonation, but no impersonate target is
// available"); curl_cffi mimics a real browser's TLS fingerprint instead.
//
// Even with that installed, the listing call fails outright (empty body,
// zero entries) roughly half the time in practice - confirmed by running it
// four times in a row locally, two clean successes and two hard failures,
// no pattern to when. Looks like TikTok's anti-bot challenge on that
// specific endpoint rather than anything wrong with the request, so this
// retries a few times with a short delay rather than surfacing a failure
// that a second attempt would've sailed through.
//
// yt-dlp's TikTok extractor gets id/description/create_time/view_count for
// every video straight from TikTok's own user-posts listing API even with
// --flat-playlist (that flag only skips resolving each video's downloadable
// formats) - so a successful call is a small handful of requests total, not
// one page load per video.
export async function fetchTikTokProfileVideos(handle, maxAttempts) {
  maxAttempts = maxAttempts || 5;
  var lastError;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchOnce(handle);
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        console.log('Attempt ' + attempt + '/' + maxAttempts + ' failed (' + e.message + '), retrying...');
        await new Promise(function (resolve) { setTimeout(resolve, attempt * 3000); });
      }
    }
  }
  throw lastError;
}

function fetchOnce(handle) {
  return new Promise(function (resolve, reject) {
    var cleanHandle = handle.replace(/^@/, '');
    var url = 'https://www.tiktok.com/@' + cleanHandle;
    var proc = spawn('yt-dlp', ['--flat-playlist', '-J', '--no-warnings', url]);
    var stdout = '';
    var stderr = '';

    proc.on('error', function (e) {
      reject(new Error('Could not run yt-dlp (' + e.message + '). Install it first: pip install -U "yt-dlp[default,curl-cffi]"'));
    });
    proc.stdout.on('data', function (c) { stdout += c; });
    proc.stderr.on('data', function (c) { stderr += c; });
    proc.on('close', function (code) {
      if (code !== 0 && !stdout) {
        reject(new Error('yt-dlp exited ' + code + ' fetching ' + url + ': ' + stderr.slice(0, 300)));
        return;
      }
      var data;
      try { data = JSON.parse(stdout); } catch (e) {
        reject(new Error('yt-dlp returned non-JSON output for ' + url + ': ' + stderr.slice(0, 300)));
        return;
      }
      var entries = (data && data.entries || []).filter(Boolean);
      if (!entries.length) {
        reject(new Error('yt-dlp returned zero videos for ' + url + ' - likely TikTok\'s anti-bot challenge on this endpoint'));
        return;
      }
      var videos = entries.map(function (e) {
        var ts = typeof e.timestamp === 'number' ? e.timestamp : null;
        return {
          id: e.id,
          text: e.description || e.title || '',
          publishedAt: ts ? new Date(ts * 1000).toISOString() : null,
          permalink: e.webpage_url || ('https://www.tiktok.com/@' + cleanHandle + '/video/' + e.id)
        };
      }).filter(function (v) { return v.id && v.publishedAt; });
      resolve(videos);
    });
  });
}
