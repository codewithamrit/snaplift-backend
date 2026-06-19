# Snaplift backend

Resolves TikTok links into direct, no-watermark video/photo/audio URLs using
`yt-dlp`, and proxies downloads so the browser gets a clean filename.

**Important — this code has not been run in this chat.** This sandbox has no
internet access, so I could not install dependencies or test a live request.
Set it up on your own machine (which has network access) and test it there
before relying on it.

## 1. Install prerequisites

You need three things on PATH: Node.js 18+, `yt-dlp`, and `ffmpeg`.

```bash
# yt-dlp (the actual TikTok extractor)
pip install -U yt-dlp

# ffmpeg (needed for audio extraction)
# macOS:
brew install ffmpeg
# Ubuntu/Debian:
sudo apt install ffmpeg
# Windows: download from https://ffmpeg.org/download.html and add to PATH
```

Verify both work:
```bash
yt-dlp --version
ffmpeg -version
```

## 2. Install and run the server

```bash
cd tiktok-backend
npm install
npm start
```

You should see:
```
Snaplift backend listening on http://localhost:8787
```

## 3. Test it directly (before touching the frontend)

```bash
curl -X POST http://localhost:8787/api/resolve \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.tiktok.com/@some.account/video/1234567890123456789"}'
```

You should get back JSON with a `formats` array containing direct CDN URLs.
If you instead get a 502 error, see Troubleshooting below.

## 4. Connect the frontend

In the frontend's `<script>` block, the `fetchTikTokData()` function currently
returns mock data. Replace its body with:

```javascript
async function fetchTikTokData(url) {
  const res = await fetch('http://localhost:8787/api/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to resolve link');
  }
  return res.json();
}
```

And change the download button handler (currently just shows a toast) to
actually trigger a file download through the proxy endpoint:

```javascript
resultsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-download, .dl-mini');
  if (!btn) return;
  const directUrl = btn.dataset.url;
  const name = (btn.dataset.name || 'snaplift-download') + (btn.dataset.ext || '.mp4');
  if (!directUrl) return;

  const proxied = `http://localhost:8787/api/download?url=${encodeURIComponent(directUrl)}&name=${encodeURIComponent(name)}`;
  window.location.href = proxied; // triggers browser's native download prompt
  showToast(`Download started: ${name}`);
});
```

You'll also need to add `data-url="${f.directUrl}"` to each generated
download button in `renderVideoResults` / `renderPhotoResults`, alongside the
existing `data-name`.

## How "no watermark" actually works

TikTok's own web/app API exposes two renditions of most videos:
- a **watermarked** version (the one you see when you share/save from the app)
- a **clean / "download"** rendition without the overlay logo, served from
  a `/download/` style CDN path

`yt-dlp`'s TikTok extractor surfaces both as separate formats. The backend
tags the clean one `nowm` and prioritizes it. If TikTok stops exposing the
clean rendition for a given post (they do this inconsistently, and it varies
by region/account), only the watermarked formats will be available — there's
no way to remove a watermark that's burned into the pixels.

## Troubleshooting

- **"Failed to start yt-dlp"** → it's not on PATH. Re-run
  `pip show yt-dlp` to find install location, or use `pip install --user`.
- **502 "Couldn't fetch that link"** → run the exact `yt-dlp -j <url>` command
  yourself in a terminal to see the real error. TikTok changes its API
  often; `yt-dlp -U` to update to the latest extractor is the first fix to try.
- **Downloads start but the file is 0 bytes / broken** → the CDN URL likely
  expired (TikTok's direct URLs are time-limited signed links) — resolve the
  link again right before downloading rather than caching it for long.
- **CORS errors in the browser console** → make sure the frontend's fetch
  URL matches the backend's actual host/port, and that `cors()` middleware
  is still enabled in `server.js`.

## Legal note

This downloads content from TikTok without going through their official API
or ToS-sanctioned export flow. Use it for your own content or with creators'
permission — redistributing others' videos without consent can violate
TikTok's terms and, depending on use, copyright or platform law in your
jurisdiction.
