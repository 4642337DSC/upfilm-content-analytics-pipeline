import { spawn } from 'node:child_process';

// Best video+audio up to 1080p, falling back to the best single progressive
// stream under 1080p if the platform doesn't expose separate streams
// (typical for TikTok/Instagram/Facebook; YouTube usually needs the merge).
var FORMAT = 'bv*[height<=1080]+ba/b[height<=1080]/best';

var DONE_MARKER = 'YTDLP_DONE\t';
var PROGRESS_MARKER = 'YTDLP_PROGRESS ';

// Runs yt-dlp for a single URL, streaming progress via onProgress({ percent })
// and onProgress({ title }) as soon as yt-dlp knows the destination filename.
// Resolves with the final { filepath, title } once the file (and any
// audio/video merge) is fully written to disk.
export function downloadOne(url, outDir, onProgress) {
  return new Promise(function (resolve, reject) {
    var args = [
      '-f', FORMAT,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--newline',
      '--no-warnings',
      '--restrict-filenames',
      '--progress-template', 'download:' + PROGRESS_MARKER + '%(progress._percent_str)s',
      '-o', '%(title).150B [%(id)s].%(ext)s',
      '--print', 'after_move:' + DONE_MARKER + '%(title)s\t%(filepath)s',
      url
    ];
    var proc = spawn('yt-dlp', args, { cwd: outDir });
    var stderrTail = [];
    var result = null;
    var buffer = '';

    function handleLine(line) {
      if (!line) return;
      if (line.indexOf(DONE_MARKER) === 0) {
        var rest = line.slice(DONE_MARKER.length);
        var tab = rest.indexOf('\t');
        result = { title: tab === -1 ? rest : rest.slice(0, tab), filepath: tab === -1 ? null : rest.slice(tab + 1) };
        return;
      }
      if (line.indexOf(PROGRESS_MARKER) === 0) {
        var m = line.slice(PROGRESS_MARKER.length).match(/([\d.]+)%/);
        if (m) onProgress({ percent: parseFloat(m[1]) });
        return;
      }
      var dest = line.match(/^\[download\] Destination: (.+)$/);
      if (dest) onProgress({ title: dest[1] });
    }

    proc.stdout.on('data', function (chunk) {
      buffer += chunk.toString();
      var lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(handleLine);
    });
    proc.stderr.on('data', function (chunk) {
      var text = chunk.toString();
      stderrTail.push(text);
      if (stderrTail.length > 20) stderrTail.shift();
    });
    proc.on('error', function (err) {
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp is not installed (or not on PATH). Install it with "pip install -U yt-dlp" and try again.'));
      } else {
        reject(new Error('Failed to launch yt-dlp: ' + err.message));
      }
    });
    proc.on('close', function (code) {
      if (buffer) handleLine(buffer);
      if (code === 0 && result && result.filepath) {
        onProgress({ percent: 100 });
        resolve(result);
      } else {
        var tail = stderrTail.join('').trim().split('\n').slice(-6).join('\n');
        reject(new Error(tail || ('yt-dlp exited with code ' + code)));
      }
    });
  });
}
