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

export function audioFormatArgs() {
  return ['-f', 'ba/b', '--no-mtime'];
}

export function videoFormatArgs() {
  return ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '--no-mtime'];
}

export function outputPath(dir, basename) {
  return path.join(dir, `${basename}.%(ext)s`);
}
