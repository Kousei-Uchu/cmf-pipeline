import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/spawn.js';

function bin() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

export async function toMp3(inputPath, outputPath) {
  await run(
    bin(),
    [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-codec:a',
      'libmp3lame',
      '-q:a',
      '2',
      '-map_metadata',
      '0',
      outputPath,
    ],
    { timeoutMs: 10 * 60_000 },
  );
  return outputPath;
}

export async function toMp4(inputPath, outputPath) {
  await run(
    bin(),
    [
      '-y',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    { timeoutMs: 30 * 60_000 },
  );
  return outputPath;
}

export async function remuxMp4(inputPath, outputPath) {
  try {
    await run(
      bin(),
      ['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outputPath],
      { timeoutMs: 10 * 60_000 },
    );
    return outputPath;
  } catch {
    return toMp4(inputPath, outputPath);
  }
}

export async function toWebm(inputPath, outputPath) {
  await run(
    bin(),
    [
      '-y',
      '-i', inputPath,
      '-c:v', 'libsvtav1',   // Switched from VP9 to AV1
      '-crf', '35',          // AV1 scales differently; 35 is highly compressed but clean
      '-preset', '4',        // 4 gives an excellent quality-to-size compression ratio
      '-pix_fmt', 'yuv420p10le', // 10-bit color reduces file size and prevents color banding
      '-c:a', 'libopus',
      '-b:a', '128k',        // 128k Opus is virtually transparent for stereo music
      outputPath,
    ],
    { timeoutMs: 30 * 60_000 },
  );
  return outputPath;
}


export async function remuxWebm(inputPath, outputPath) {
  try {
    await run(bin(), ['-y', '-i', inputPath, '-c', 'copy', outputPath], {
      timeoutMs: 10 * 60_000,
    });
    return outputPath;
  } catch {
    return toWebm(inputPath, outputPath);
  }
}

/**
 * True if the file has at least one video stream (as opposed to an
 * audio-only file that merely got wrapped in a video container).
 */
export async function probeHasVideoStream(inputPath) {
  try {
    const { stdout } = await run(
      process.env.FFPROBE_PATH || 'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'csv=p=0',
        inputPath,
      ],
      { timeoutMs: 30_000 },
    );
    return stdout
      .trim()
      .split('\n')
      .some((line) => line.trim() === 'video');
  } catch {
    return false;
  }
}

/**
 * Mono f32le PCM for the first `seconds` of a file, 8 kHz.
 */
export async function extractPcmEnvelope(inputPath, seconds = 30) {
  const { stdout } = await run(
    bin(),
    [
      '-hide_banner',
      '-nostats',
      '-i',
      inputPath,
      '-t',
      String(seconds),
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { timeoutMs: 120_000, binary: true },
  );
  const buf = stdout;
  const aligned = buf.byteOffset % 4 === 0 ? buf : Buffer.from(buf);
  const samples = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 4),
  );
  const window = 400; // 50ms at 8kHz
  const envelope = [];
  for (let i = 0; i + window <= samples.length; i += window) {
    let sum = 0;
    for (let j = 0; j < window; j++) sum += samples[i + j] * samples[i + j];
    envelope.push(Math.sqrt(sum / window));
  }
  return envelope;
}

export function envelopeCorrelation(a, b) {
  if (!a?.length || !b?.length) return 0;
  const n = Math.min(a.length, b.length);
  if (n < 8) return 0;
  // Try a few alignments in case the video has a cold open.
  let best = 0;
  const maxLag = Math.min(40, Math.floor(n / 4));
  for (const [x, y] of [
    [a, b],
    [b, a],
  ]) {
    for (let lag = 0; lag <= maxLag; lag++) {
      const len = n - lag;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let i = 0; i < len; i++) {
        const vx = x[i];
        const vy = y[i + lag];
        sx += vx;
        sy += vy;
        sxx += vx * vx;
        syy += vy * vy;
        sxy += vx * vy;
      }
      const cov = sxy - (sx * sy) / len;
      const vx = sxx - (sx * sx) / len;
      const vy = syy - (sy * sy) / len;
      if (vx <= 0 || vy <= 0) continue;
      const r = cov / Math.sqrt(vx * vy);
      if (r > best) best = r;
    }
  }
  return Math.max(0, best);
}

export async function probeDurationSec(inputPath) {
  try {
    const { stdout } = await run(
      process.env.FFPROBE_PATH || 'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ],
      { timeoutMs: 30_000 },
    );
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function findNewestMedia(dir, basenameHint) {
  const names = await fs.readdir(dir);
  const matches = names.filter((n) => n.startsWith(basenameHint) && !n.endsWith('.part'));
  if (!matches.length) return null;
  const stats = await Promise.all(
    matches.map(async (name) => {
      const p = path.join(dir, name);
      const st = await fs.stat(p);
      return { path: p, mtime: st.mtimeMs };
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0].path;
}