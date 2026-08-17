# Social Downloader

A standalone bulk video downloader with a paste-URLs web UI. Not part of the
analytics pipeline in this repo — it's a separate tool that lives in its own
folder with its own `package.json`.

Paste TikTok, Instagram, YouTube, or Facebook video URLs (one per line),
click Download, and it fetches each one at up to 1080p using
[yt-dlp](https://github.com/yt-dlp/yt-dlp) under the hood. Progress streams
live per URL; finished files get an individual download link plus a
"download all as .zip" option once the batch is done.

## Prerequisites

- Node.js >= 20
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your `PATH`
  - `pip install -U yt-dlp` (or `brew install yt-dlp`, or download the
    standalone binary from yt-dlp's releases page)
- `ffmpeg` on your `PATH` — needed to merge separate video/audio streams for
  1080p on platforms (mainly YouTube) that don't serve a single progressive
  file at that resolution
  - `brew install ffmpeg` / `apt install ffmpeg` / etc.

## Setup

```
cd tools/downloader
npm install
npm start
```

Then open `http://localhost:4173` (override with `PORT=xxxx npm start`).

## Notes

- **Private / login-walled content** (private accounts, age-gated videos,
  etc.) isn't downloadable without authentication. yt-dlp supports a
  `--cookies-from-browser` / `--cookies cookies.txt` flag for this; if you
  need it, add it to the `args` array in `server/downloader.js`.
- Downloaded files land in `downloads/<job-id>/` on disk and are served back
  through the app; nothing is uploaded anywhere else.
- Batches are capped at 50 URLs and processed 2 at a time (see
  `MAX_URLS_PER_JOB` in `server/index.js` and `CONCURRENCY` in
  `server/jobs.js`) to stay reasonably polite to the source platforms.
- Only use this against content you have the right to download — respect
  each platform's terms of service and copyright law.
