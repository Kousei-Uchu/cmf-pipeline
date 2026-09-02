# CMF Pipeline

Personal media pipeline that runs **on your machine**. Search YouTube (Innertube) and Spotify, pick audio / video / both, match a music video with weighted metadata + waveform scoring, then pack a `.cmf` archive (a zip with a different extension).

## Why a local Node server (not WASM + CORS proxy)

In-browser yt-dlp via Pyodide still needs a **CORS proxy** for YouTube, Spotify, and `googlevideo.com`. That proxy *is* a backend, and it would haul every media byte through itself. yt-dlp also depends on native bits that are awkward in WASM.

This app keeps the UI in the browser and runs Innertube, the Spotify client-credentials API, yt-dlp, and ffmpeg as local processes. Nothing is sent to a remote encode farm.

## Spotify: Method B (not SpotDL)

Spotify’s API does not give you audio files. SpotDL is already “metadata from Spotify + media from YouTube.” Talking to Spotify ourselves (client credentials, not a user login) then downloading with yt-dlp is the same idea with cleaner official album/artist metadata and no extra Python stack.

## Requirements

- Node 20+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on `PATH`
- [ffmpeg](https://ffmpeg.org/) (and `ffprobe`) on `PATH`

Optional: a Spotify app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) with **Client ID** and **Client Secret**.

Optional: a free [Genius API client](https://genius.com/api-clients) (New API Client → Generate Access Token) for `GENIUS_ACCESS_TOKEN`. See "Music video matching" below.

## Setup

```bash
cd cmf-pipeline
cp .env.example .env
# fill SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET if you want Spotify URLs and catalog search
npm install
npm start
```

Open `http://127.0.0.1:8787`.

To let other devices on your LAN hit export URLs, set `HOST=0.0.0.0` in `.env`.

## Flow

1. Search (Innertube + optional Spotify) or paste a URL (YouTube, Spotify, or anything yt-dlp understands).
2. Select a result. Albums / playlists / artists expand to tracks.
3. Choose **Audio only**, **Video only**, or **Audio and video**.
4. Confirm. The server downloads, converts to `.mp3` / `.webm`, pulls covers and artist images, writes `info.json`, and zips a `.cmf`.
5. Download the file, copy a short-lived export URL, or (if the archive is under 25MB) copy a `data:` URL.

Automated search:

```
GET /api/search?query={query}
```

Same contract as the UI. URL queries resolve and expand playlists/albums.

## `.cmf` layout

```
/{item_title}_{item_author}/
  info.json
  audio/          # .mp3 when requested
  video/          # .webm when requested (AV1/Opus, matched to source bitrate — see Matching)
  assets/         # cover, artist image, …
```

Identical file contents (same SHA-256) are stored once in the zip; later copies are skipped. That keeps shared album art from being duplicated.

`info.json` includes `item_title`, `item_author`, `album_meta`, `author_meta`, `paths` (relative to archive root), source IDs, and the matcher breakdown.

## Matching

Audio is always sourced from YouTube via the weighted search below — Genius is never consulted for audio.

For video, candidates are scored on title similarity, artist/channel, duration, official-video vs lyric/live penalties, and (when both audio and video are requested) RMS-envelope correlation of the first ~30 seconds. YouTube Music “Artist - Topic” / “Official Audio” names are cleaned before packing.

### Music video matching (Genius)

If `GENIUS_ACCESS_TOKEN` is set, video selection asks [Genius](https://genius.com) first instead of relying purely on weighted YouTube search: a Genius song page's linked YouTube media (filtered to non-`- Topic` channels) is a stronger "does an MV exist, and which upload is it" signal than free-text search scoring.

- **Genius points at a specific video** — that upload is used directly (skipping the match-score threshold), then downloaded through the normal pipeline below.
- **Genius confirms no MV exists** (every linked upload is a `- Topic` audio track) — video is skipped entirely for that song; it ships audio-only.
- **Genius has no usable answer** (not configured, no song match, no YouTube media, or an MV may exist but none of its linked uploads survived the `- Topic` filter) — falls back to the weighted YouTube search unchanged.

Either way, once a video candidate is chosen it goes through the same download → video-stream check → audio-only fallback safety net as before.

### Video encoding

Downloaded video is remuxed to `.webm` (stream-copied when the source codec already fits the container; otherwise re-encoded to AV1/Opus). The re-encode uses CRF 20 (constant-quality, override with `AV1_CRF`) rather than a fixed bitrate — CRF adapts bits-per-frame to scene complexity, which is what buys real space savings without a visible quality drop: simple scenes cost fewer bits, busy ones cost more. 18-22 is the range most SVT-AV1 testing calls visually transparent; music videos tend to hold up fine at the higher end of that. Audio re-encodes to Opus at 128k (override with `OPUS_BITRATE`), already considered transparent for stereo music.

By default the re-encode runs on `libsvtav1` — software, CPU-only, works everywhere. If you have an RTX 40-series+ GPU **and the server itself is running on that machine** (subprocess calls aren't remote), set `AV1_ENCODER=av1_nvenc` to use the hardware AV1 encoder instead — roughly an order of magnitude faster, at some compression-efficiency cost (comparable quality target, somewhat larger files than software AV1). Requires an ffmpeg build with NVENC support compiled in; most prebuilt Windows/Linux builds have it, Apple Silicon builds don't. `AV1_PRESET` controls the speed/quality tradeoff within whichever encoder is active — the scales aren't comparable between them (`libsvtav1`: `0` slowest/best → `13` fastest/worst, default `4`; `av1_nvenc`: `p1` fastest/worst → `p7` slowest/best, default `p5`).

## Logging

Set `LOG_LEVEL=debug` (or `DEBUG=1`) in `.env` or the environment to get a full trace of everything the server does: every HTTP request/response (with a shared request id), every yt-dlp/ffmpeg/ffprobe subprocess invocation (exact argv, every stdout/stderr chunk, exit code, duration), every Spotify/Innertube HTTP call and its timing, every job's internal steps (candidate search, scoring breakdown per candidate, waveform correlation, download attempts and rejections), and archive packing. Secrets (Spotify client secret, bearer tokens) are always redacted from log output regardless of level.

```bash
LOG_LEVEL=debug npm start
```

Default level is `info`, which only logs startup and real warnings/errors — safe for normal use. Levels: `error`, `warn`, `info`, `debug`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | yt-dlp / ffmpeg / Spotify status |
| GET | `/api/search?query=` | Search or URL resolve |
| GET | `/api/expand?source=&type=&id=` | Expand a Spotify album/playlist/artist |
| POST | `/api/jobs` | `{ items, mode: "audio"\|"video"\|"both" }` |
| GET | `/api/jobs/:id/events` | SSE progress |
| GET | `/api/jobs/:id/file` | Download `.cmf` |
| GET | `/api/export/:id` | Same file as a shareable URL |
| GET | `/api/export/:id?format=dataurl` | JSON with a `data:` URL (size-capped) |

Use this only with media you have the right to copy. YouTube and Spotify terms still apply.