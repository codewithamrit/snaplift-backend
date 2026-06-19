/**
 * Snaplift backend
 * -----------------
 * Resolves a TikTok URL into direct, no-watermark media URLs using yt-dlp,
 * and proxies the actual file download so the browser gets a clean
 * filename and a proper download prompt instead of hitting TikTok's CDN
 * directly (which often blocks hot-linking without the right headers/cookies).
 *
 * Requires:
 *   - Node.js 18+
 *   - yt-dlp installed and on PATH   (pip install -U yt-dlp   OR   brew install yt-dlp)
 *   - ffmpeg installed and on PATH   (needed for audio extraction / muxing)
 *
 * Run:
 *   npm install
 *   npm start
 *   -> listens on http://localhost:8787
 */

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors());
app.use(express.json());



// Simple in-memory cache so re-clicking "Fetch" on the same link inside a
// few minutes doesn't re-invoke yt-dlp every time. Keyed by URL.
const resolveCache = new Map(); // url -> { data, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

function isTikTokUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)tiktok\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Runs `yt-dlp -j <url>` (dump single JSON) and resolves with the parsed
 * metadata. yt-dlp's TikTok extractor returns watermark-free formats
 * directly (TikTok's "download" CDN URLs, no overlay logo), distinct from
 * the watermarked formats also listed.
 */
function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-j', // dump JSON metadata, no download
      '--no-warnings',
      '--no-playlist',
      url,
    ];

    const proc = spawn('yt-dlp', args, { timeout: 30_000 });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));

    proc.on('error', (err) => {
      // ENOENT etc — yt-dlp not installed / not on PATH
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }
      try {
        // yt-dlp can print one JSON object per line for multi-entry results;
        // for a single TikTok post it's one line.
        const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
        resolve(JSON.parse(lastLine));
      } catch (err) {
        reject(new Error(`Could not parse yt-dlp output: ${err.message}`));
      }
    });
  });
}

function bytesOrNull(n) {
  return typeof n === 'number' && n > 0 ? n : null;
}

/**
 * Normalizes yt-dlp's raw info dict into the shape the Snaplift frontend
 * expects: { type, id, author, title, formats: [...] } for videos, or
 * { type:'photo', id, author, title, photos:[...], audio } for slideshows.
 */
function normalize(info) {
  const author = info.uploader ? `@${info.uploader}` : (info.channel || 'unknown');
  const title = info.title || info.description?.slice(0, 80) || 'TikTok post';
  const id = info.id || crypto.randomUUID();

  // TikTok photo carousels: yt-dlp exposes them via `info.entries` (when
  // extracted as a slideshow) or a top-level `_type: "playlist"` with
  // image entries. Some versions expose `info.image_urls` directly.
  const isPhotoPost =
    info._type === 'playlist' ||
    (Array.isArray(info.entries) && info.entries.length > 0) ||
    Array.isArray(info.image_urls);

  if (isPhotoPost) {
    const rawPhotos = info.image_urls || (info.entries || []).map((e) => e.url || e.thumbnail);
    const photos = rawPhotos
      .filter(Boolean)
      .map((directUrl, i) => ({
        label: `Photo ${i + 1}`,
        directUrl,
      }));

    // Background audio track, if yt-dlp surfaced one of the formats as audio-only.
    const audioFormat = (info.formats || []).find((f) => f.vcodec === 'none' && f.acodec !== 'none');

    return {
      type: 'photo',
      id,
      author,
      title,
      photos,
      audio: audioFormat
        ? {
            label: 'Original sound',
            directUrl: audioFormat.url,
            sizeBytes: bytesOrNull(audioFormat.filesize || audioFormat.filesize_approx),
          }
        : null,
    };
  }

  // Video post: yt-dlp's TikTok extractor typically returns formats like
  // "download" (no watermark, server-side render) and "watermarked" /
  // "play" (with watermark), plus an audio-only stream when available.
  // Field names can shift between yt-dlp versions, so we match loosely on
  // format_id / format_note rather than one exact string.
  const formats = (info.formats || []).map((f) => {
    const idNote = `${f.format_id || ''} ${f.format_note || ''}`.toLowerCase();
    const isAudioOnly = f.vcodec === 'none' && f.acodec !== 'none';
    const isNoWatermark = !isAudioOnly && /download|nowm|no.?watermark/.test(idNote);
    const isWatermarked = !isAudioOnly && !isNoWatermark && /watermark|play/.test(idNote);

    let tag = 'sd';
    let label = f.format_note || f.format_id || 'Video';
    if (isAudioOnly) {
      tag = 'audio';
      label = 'Audio only · MP3';
    } else if (isNoWatermark) {
      tag = 'nowm';
      label = (f.height || 0) >= 1080 ? 'HD · No watermark' : 'SD · No watermark';
    } else if (isWatermarked) {
      tag = (f.height || 0) >= 1080 ? 'hd' : 'sd';
      label = (f.height || 0) >= 1080 ? 'HD · With watermark' : 'SD · With watermark';
    } else if ((f.height || 0) >= 1080) {
      tag = 'hd';
      label = 'HD';
    }

    return {
      label,
      tag,
      resolution: isAudioOnly
        ? `${Math.round((f.abr || 128))} kbps`
        : f.width && f.height
        ? `${f.width}×${f.height}`
        : 'Unknown',
      sizeBytes: bytesOrNull(f.filesize || f.filesize_approx),
      directUrl: f.url,
    };
  })
  // Drop formats yt-dlp listed without a usable direct URL.
  .filter((f) => !!f.directUrl);

  // De-duplicate near-identical entries (yt-dlp sometimes lists the same
  // rendition twice under different protocol variants) and prefer the
  // highest-quality of each tag.
  const seen = new Map();
  for (const f of formats) {
    const key = f.tag;
    const existing = seen.get(key);
    if (!existing || (f.sizeBytes || 0) > (existing.sizeBytes || 0)) {
      seen.set(key, f);
    }
  }

  return {
    type: 'video',
    id,
    author,
    title,
    formats: Array.from(seen.values()),
  };
}

app.post('/api/resolve', async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url" in request body.' });
  }
  if (!isTikTokUrl(url)) {
    return res.status(400).json({ error: 'That doesn\u2019t look like a TikTok link.' });
  }

  const cached = resolveCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.data);
  }

  try {
    const info = await runYtDlp(url);
    const data = normalize(info);

    if (data.type === 'video' && data.formats.length === 0) {
      return res.status(502).json({
        error: 'TikTok returned no downloadable formats for this link. It may be private, age-restricted, or removed.',
      });
    }

    resolveCache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json(data);
  } catch (err) {
    console.error('[resolve] failed:', err.message);
    res.status(502).json({
      error: 'Couldn\u2019t fetch that link. It may be private, deleted, region-locked, or TikTok changed something on their end.',
    });
  }
});

/**
 * Streams the actual file through our server so the browser gets a sane
 * filename and Content-Disposition header, instead of linking directly to
 * TikTok's CDN (which can reject requests missing TikTok's own headers/
 * cookies, and which exposes the raw CDN URL to the user).
 *
 * GET /api/download?url=<encoded direct CDN url>&name=<suggested filename>
 */
app.get('/api/download', async (req, res) => {
  const { url, name } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).send('Missing url parameter.');
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    return res.status(400).send('Invalid url parameter.');
  }

  // Only ever proxy TikTok's own CDN domains, never an arbitrary URL the
  // client supplies — this endpoint is not an open proxy.
  const allowedHostSuffixes = ['.tiktokcdn.com', '.tiktokcdn-us.com', '.tiktokv.com', '.muscdn.com', '.bytedapm.com'];
  const hostOk = allowedHostSuffixes.some((suffix) => target.hostname.endsWith(suffix));
  if (!hostOk) {
    return res.status(403).send('Refusing to proxy this host.');
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        // TikTok's CDN generally wants a browser-like UA and a TikTok referer.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://www.tiktok.com/',
      },
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).send('Upstream file fetch failed.');
    }

    const safeName = (name || 'snaplift-download').replace(/[^a-zA-Z0-9 _\-.]/g, '').slice(0, 120) || 'download';
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipeTo(
      new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
        close() {
          res.end();
        },
        abort(err) {
          console.error('[download] stream aborted:', err);
          res.end();
        },
      })
    );
  } catch (err) {
    console.error('[download] failed:', err.message);
    res.status(502).send('Could not download the file from TikTok\u2019s CDN.');
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Explicitly pass '0.0.0.0' as the host argument so Railway can route traffic to it
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Snaplift backend listening on port ${PORT}`);
  console.log(`Make sure yt-dlp is installed and up to date: yt-dlp -U`);
});
