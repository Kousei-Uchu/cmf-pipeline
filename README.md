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
4. Confirm. The server downloads, converts to `.mp3` / `.mp4`, pulls covers and artist images, writes `info.json`, and zips a `.cmf`.
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
  video/          # .mp4 when requested
  assets/         # cover, artist image, …
```

Identical file contents (same SHA-256) are stored once in the zip; later copies are skipped. That keeps shared album art from being duplicated.

`info.json` includes `item_title`, `item_author`, `album_meta`, `author_meta`, `paths` (relative to archive root), source IDs, and the matcher breakdown.

## Matching

Candidates are scored on title similarity, artist/channel, duration, official-video vs lyric/live penalties, and (when both audio and video are requested) RMS-envelope correlation of the first ~30 seconds. YouTube Music “Artist - Topic” / “Official Audio” names are cleaned before packing.

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
