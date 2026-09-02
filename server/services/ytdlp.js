import path from 'node:path';
import { run } from '../lib/spawn.js';

function bin() {
  return process.env.YTDLP_PATH || 'yt-dlp';
}

export async function ytDlpJson(target, extraArgs = []) {
  const { stdout } = await run(
    bin(),
    [
      '-J',
      '--no-warnings',
      '--skip-download',
      '--flat-playlist',
      '--yes-playlist',
      '--no-check-certificates',
      ...extraArgs,
      target,
    ],
    { timeoutMs: 120_000 },
  );
  return JSON.parse(stdout);
}

export async function ytSearch(query, n = 8) {
  const json = await ytDlpJson(`ytsearch${n}:${query}`, ['--no-playlist']);
  const entries = json.entries || (json.id ? [json] : []);
  return entries.filter(Boolean).map(mapDump);
}

export function mapDump(dump) {
  if (!dump) return null;
  const id = dump.id || dump.display_id;
  return {
    id: dump.extractor ? `${dump.extractor}:${id}` : id,
    extractor: dump.extractor || dump.ie_key || 'generic',
    source: 'ytdlp',
    type: dump._type === 'playlist' ? 'playlist' : 'video',
    youtube_id: dump.extractor === 'youtube' ? id : dump.id,
    url: dump.webpage_url || dump.original_url || dump.url,
    title: dump.title || dump.fulltitle || 'Untitled',
    author: dump.artist || dump.creator || dump.uploader || dump.channel || 'Unknown',
    channel: dump.channel || dump.uploader || null,
    duration_ms: dump.duration != null ? Math.round(Number(dump.duration) * 1000) : null,
    view_count: dump.view_count ?? null,
    thumbnail: dump.thumbnail || dump.thumbnails?.[0]?.url || null,
    album: dump.album || null,
    track: dump.track || dump.title,
    description: dump.description || '',
    release_year: dump.release_year || dump.release_date || null,
    entries: Array.isArray(dump.entries)
      ? dump.entries.filter(Boolean).map((e) => ({
          id: e.id,
          title: e.title,
          url: e.url || e.webpage_url,
          duration_ms: e.duration != null ? Math.round(Number(e.duration) * 1000) : null,
        }))
      : null,
  };
}

export async function downloadMedia(url, outputTemplate, formatArgs, onProgress) {
  const args = [
    '-o',
    outputTemplate,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--no-check-certificates',
    ...formatArgs,
    url,
  ];
  await run(bin(), args, {
    timeoutMs: 20 * 60_000,
    onStderr: onProgress,
    onStdout: onProgress,
  });
}

// Speed-up args shared by audio/video downloads. By default this asks
// yt-dlp's native downloader to pull fragments concurrently. If aria2c is
// installed and USE_ARIA2C isn't explicitly disabled, hand the download off
// to it instead for multi-connection-per-file throughput.
function speedArgs() {
  const fragments = Number(process.env.YTDLP_CONCURRENT_FRAGMENTS || 4);
  if (process.env.USE_ARIA2C === '0') {
    return ['--concurrent-fragments', String(fragments)];
  }
  const connections = Number(process.env.ARIA2C_CONNECTIONS || 8);
  return [
    '--downloader', 'aria2c',
    '--downloader-args', `aria2c:-x ${connections} -s ${connections} -k 1M`,
    '--concurrent-fragments', String(fragments),
  ];
}

export function audioFormatArgs() {
  return ['-f', 'ba/b', '--no-mtime', ...speedArgs()];
}

export function videoFormatArgs() {
  return [
    '-f',
    'bv*[vcodec^=av01]+ba[acodec=opus]/bv*+ba/b',
    // mkv accepts any video/audio codec pairing, so yt-dlp's internal merge
    // step never fails here even when the fallback selector picks a
    // non-webm-native codec (e.g. H.264). The app's own remuxWebm() step
    // does the final webm conversion afterward (copy when possible, else
    // transcode).
    '--merge-output-format',
    'mkv',
    '--no-mtime',
    ...speedArgs(),
  ];
}

export function outputPath(dir, basename) {
  return path.join(dir, `${basename}.%(ext)s`);
}