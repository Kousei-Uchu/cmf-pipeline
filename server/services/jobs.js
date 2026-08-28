import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { folderName } from '../lib/slug.js';
import { cleanArtistName, stripTitleNoise } from '../lib/text.js';
import { EXPORTS_DIR, TMP_DIR } from '../lib/paths.js';
import { searchYouTube } from './innertube.js';
import { ytSearch, downloadMedia, audioFormatArgs, videoFormatArgs, outputPath } from './ytdlp.js';
import {
  toMp3,
  remuxMp4,
  extractPcmEnvelope,
  envelopeCorrelation,
  findNewestMedia,
} from './ffmpeg.js';
import { rankCandidates, scoreCandidate } from './matcher.js';
import { enrichAlbumAndArtist, pickImage, spotifyConfigured } from './spotify.js';
import { downloadBinary, extFromUrl, packCmf, writeJson } from './cmf.js';

const jobs = new Map();

export function getJob(id) {
  return jobs.get(id);
}

function emit(job, payload) {
  job.events.push(payload);
  for (const res of job.listeners) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

export function attachSse(job, res) {
  job.listeners.add(res);
  for (const ev of job.events) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  if (job.status === 'done' || job.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'close' })}\n\n`);
    res.end();
    job.listeners.delete(res);
  }
}

export function detachSse(job, res) {
  job.listeners.delete(res);
}

export async function createJob({ items, mode, exportKind }) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued',
    mode,
    exportKind: exportKind || 'file',
    items,
    events: [],
    listeners: new Set(),
    filePath: null,
    fileName: null,
    exportUrlPath: null,
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  setImmediate(() => runJob(job).catch((err) => fail(job, err)));
  return job;
}

function fail(job, err) {
  job.status = 'error';
  job.error = err.message || String(err);
  emit(job, { type: 'error', message: job.error });
  emit(job, { type: 'close' });
  for (const res of job.listeners) res.end();
  job.listeners.clear();
}

async function runJob(job) {
  job.status = 'running';
  emit(job, { type: 'status', message: 'Preparing workspace' });
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  const work = path.join(TMP_DIR, job.id);
  const staged = path.join(work, 'cmf');
  await fs.mkdir(staged, { recursive: true });

  const usedFolders = new Set();
  const mode = job.mode;
  let index = 0;
  for (const raw of job.items) {
    index += 1;
    emit(job, {
      type: 'item',
      index,
      total: job.items.length,
      title: raw.title,
      message: `Resolving ${raw.title}`,
    });
    await processItem(job, raw, staged, usedFolders, mode, index);
  }

  emit(job, { type: 'status', message: 'Packing .cmf archive' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `library_${stamp}.cmf`;
  const outPath = path.join(EXPORTS_DIR, `${job.id}.cmf`);
  const packed = await packCmf(staged, outPath);
  job.filePath = outPath;
  job.fileName = fileName;
  job.exportUrlPath = `/api/export/${job.id}`;
  job.skipped = packed.skipped;
  job.status = 'done';
  emit(job, {
    type: 'done',
    fileName,
    download: `/api/jobs/${job.id}/file`,
    exportUrl: job.exportUrlPath,
    skipped: packed.skipped,
    bytes: packed.bytes,
  });
  emit(job, { type: 'close' });
  for (const res of job.listeners) res.end();
  job.listeners.clear();

  fs.rm(work, { recursive: true, force: true }).catch(() => {});
}

async function processItem(job, raw, staged, usedFolders, mode, index) {
  const title = stripTitleNoise(raw.title || 'Untitled');
  const author = cleanArtistName(raw.author, raw.channel, raw.raw_title || raw.title);
  let folder = folderName(title, author);
  if (usedFolders.has(folder)) folder = `${folder}_${index}`;
  usedFolders.add(folder);

  const itemDir = path.join(staged, folder);
  const audioDir = path.join(itemDir, 'audio');
  const videoDir = path.join(itemDir, 'video');
  const assetsDir = path.join(itemDir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });
  const wantAudio = mode === 'audio' || mode === 'both';
  const wantVideo = mode === 'video' || mode === 'both';
  if (wantAudio) await fs.mkdir(audioDir, { recursive: true });
  if (wantVideo) await fs.mkdir(videoDir, { recursive: true });

  const tmpItem = path.join(TMP_DIR, job.id, `work_${index}`);
  await fs.mkdir(tmpItem, { recursive: true });

  let album_meta = raw.album || null;
  let author_meta = raw.artists?.[0] || { name: author };
  if (raw.source === 'spotify' && spotifyConfigured() && (raw.album?.id || raw.artists?.[0]?.id)) {
    try {
      const extra = await enrichAlbumAndArtist(raw);
      if (extra.album) album_meta = extra.album;
      if (extra.artist) author_meta = extra.artist;
    } catch (err) {
      emit(job, { type: 'log', message: `Spotify enrich skipped: ${err.message}` });
    }
  }

  const target = {
    title,
    author,
    duration_ms: raw.duration_ms,
    intent: 'audio',
  };

  const matchNotes = {};
  let audioRel = null;
  let videoRel = null;
  let audioFile = null;

  if (wantAudio) {
    emit(job, { type: 'phase', item: index, phase: 'audio', message: 'Finding audio source' });
    const audioPick = await pickSource(raw, { ...target, intent: 'audio' }, 'audio');
    matchNotes.audio = audioPick.note;
    emit(job, { type: 'phase', item: index, phase: 'audio', message: `Downloading audio: ${audioPick.url}` });
    await downloadMedia(audioPick.url, outputPath(tmpItem, 'audio'), audioFormatArgs(), (chunk) => {
      const line = String(chunk).trim().split('\n').pop();
      if (line) emit(job, { type: 'ytdlp', item: index, line });
    });
    const src = await findNewestMedia(tmpItem, 'audio');
    if (!src) throw new Error(`No audio file downloaded for ${title}`);
    const dest = path.join(audioDir, `${folder}.mp3`);
    await toMp3(src, dest);
    audioFile = dest;
    audioRel = `/${folder}/audio/${folder}.mp3`;
  }

  if (wantVideo) {
    emit(job, { type: 'phase', item: index, phase: 'video', message: 'Matching music video' });
    const videoPick = await pickSource(raw, { ...target, intent: 'video' }, 'video');
    let ranked = videoPick.ranked || [];
    if (audioFile && ranked.length) {
      const top = ranked.slice(0, 3);
      emit(job, {
        type: 'phase',
        item: index,
        phase: 'waveform',
        message: `Waveform-matching top ${top.length} video candidates`,
      });
      const audioEnv = await extractPcmEnvelope(audioFile, 30).catch(() => null);
      if (audioEnv) {
        for (const row of top) {
          try {
            const probeDir = path.join(tmpItem, `probe_${row.candidate.youtube_id || row.candidate.id}`);
            await fs.mkdir(probeDir, { recursive: true });
            const url = row.candidate.url;
            await downloadMedia(url, outputPath(probeDir, 'clip'), [
              '-f',
              'ba/b',
              '--no-mtime',
              '--download-sections',
              '*0:00-0:35',
            ]);
            const clip = await findNewestMedia(probeDir, 'clip');
            if (!clip) continue;
            const env = await extractPcmEnvelope(clip, 30);
            const wave = envelopeCorrelation(audioEnv, env);
            row.candidate.waveform = wave;
            row.score = scoreCandidate({ ...target, intent: 'video' }, row.candidate, wave);
          } catch (err) {
            emit(job, { type: 'log', message: `Waveform probe skipped: ${err.message}` });
          }
        }
        ranked = [...ranked].sort((a, b) => b.score.total - a.score.total);
        videoPick.candidate = ranked[0].candidate;
        videoPick.url = ranked[0].candidate.url;
        videoPick.note = {
          ...videoPick.note,
          waveform_applied: true,
          winner: ranked[0].score,
        };
      }
    }
    matchNotes.video = videoPick.note;
    emit(job, { type: 'phase', item: index, phase: 'video', message: `Downloading video: ${videoPick.url}` });
    await downloadMedia(videoPick.url, outputPath(tmpItem, 'video'), videoFormatArgs(), (chunk) => {
      const line = String(chunk).trim().split('\n').pop();
      if (line) emit(job, { type: 'ytdlp', item: index, line });
    });
    const src = await findNewestMedia(tmpItem, 'video');
    if (!src) throw new Error(`No video file downloaded for ${title}`);
    const dest = path.join(videoDir, `${folder}.mp4`);
    await remuxMp4(src, dest);
    videoRel = `/${folder}/video/${folder}.mp4`;
  }

  const assetRels = [];
  const coverUrl =
    pickImage(album_meta?.images)?.url ||
    raw.thumbnail ||
    (raw.youtube_id ? `https://i.ytimg.com/vi/${raw.youtube_id}/hqdefault.jpg` : null);
  const artistUrl = pickImage(author_meta?.images)?.url || null;

  if (coverUrl) {
    try {
      const ext = extFromUrl(coverUrl);
      const name = `cover${ext}`;
      await downloadBinary(coverUrl, path.join(assetsDir, name));
      assetRels.push(`/${folder}/assets/${name}`);
    } catch (err) {
      emit(job, { type: 'log', message: `Cover skipped: ${err.message}` });
    }
  }
  if (artistUrl && artistUrl !== coverUrl) {
    try {
      const ext = extFromUrl(artistUrl);
      const name = `artist${ext}`;
      await downloadBinary(artistUrl, path.join(assetsDir, name));
      assetRels.push(`/${folder}/assets/${name}`);
    } catch (err) {
      emit(job, { type: 'log', message: `Artist image skipped: ${err.message}` });
    }
  }

  const info = {
    item_title: title,
    item_author: author,
    album_meta: album_meta || {},
    author_meta: author_meta || {},
    paths: {
      audio: audioRel,
      video: videoRel,
      assets: assetRels,
    },
    source: {
      origin: raw.source,
      url: raw.url || null,
      spotify_id: raw.spotify_id || null,
      youtube_id: raw.youtube_id || null,
      isrc: raw.isrc || null,
    },
    duration_ms: raw.duration_ms || null,
    match: matchNotes,
    packed_at: new Date().toISOString(),
    mode,
  };
  await writeJson(path.join(itemDir, 'info.json'), info);
  emit(job, { type: 'item_done', index, folder, title });
}

async function pickSource(raw, target, kind) {
  if (kind === 'audio' && raw.youtube_id && raw.source === 'youtube' && target.intent === 'audio') {
    return {
      url: raw.url || `https://www.youtube.com/watch?v=${raw.youtube_id}`,
      candidate: raw,
      note: { strategy: 'provided_youtube_id', score: null },
    };
  }
  if (kind === 'video' && raw.youtube_id && raw.source === 'youtube' && !raw.spotify_id) {
    // Direct YouTube picks: still search for a better official video when mode is video-only
    // if the title looks like audio.
    const looksAudio = /official audio|topic|visualizer|lyric/i.test(`${raw.raw_title || ''} ${raw.channel || ''}`);
    if (!looksAudio) {
      return {
        url: raw.url || `https://www.youtube.com/watch?v=${raw.youtube_id}`,
        candidate: raw,
        note: { strategy: 'provided_youtube_id', score: null },
      };
    }
  }

  const query =
    kind === 'video'
      ? `${target.author} ${target.title} official music video`
      : `${target.author} ${target.title} official audio`;

  let candidates = [];
  try {
    const yt = await searchYouTube(query);
    candidates = (kind === 'video' ? yt.videos : yt.music.length ? yt.music : yt.items) || [];
    if (!candidates.length) candidates = yt.items || [];
  } catch {
    candidates = [];
  }
  if (candidates.length < 3) {
    try {
      const extra = await ytSearch(query, 8);
      candidates = candidates.concat(
        extra.map((e) => ({
          title: e.title,
          author: e.author,
          channel: e.channel,
          raw_title: e.title,
          duration_ms: e.duration_ms,
          url: e.url,
          youtube_id: e.youtube_id,
        })),
      );
    } catch {
      // ignore
    }
  }

  if (raw.youtube_id) {
    candidates.unshift({
      title: raw.title,
      author: raw.author,
      channel: raw.channel,
      raw_title: raw.raw_title || raw.title,
      duration_ms: raw.duration_ms,
      url: raw.url,
      youtube_id: raw.youtube_id,
    });
  }

  const dedup = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = c.youtube_id || c.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(c);
  }
  const ranked = rankCandidates(target, dedup);
  if (!ranked.length) {
    if (raw.url) {
      return { url: raw.url, candidate: raw, note: { strategy: 'fallback_url' }, ranked: [] };
    }
    throw new Error(`No ${kind} candidates for ${target.title}`);
  }
  const winner = ranked[0];
  return {
    url: winner.candidate.url,
    candidate: winner.candidate,
    ranked,
    note: {
      strategy: 'weighted_search',
      query,
      score: winner.score,
      considered: ranked.slice(0, 8).map((r) => ({
        title: r.candidate.title,
        url: r.candidate.url,
        total: Number(r.score.total.toFixed(4)),
        parts: r.score.parts,
      })),
    },
  };
}

export function pruneExports() {
  const ttl = Number(process.env.EXPORT_TTL_HOURS || 24) * 3600_000;
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > ttl) {
      if (job.filePath) fs.rm(job.filePath, { force: true }).catch(() => {});
      jobs.delete(id);
    }
  }
}

setInterval(pruneExports, 60 * 60_000).unref();
