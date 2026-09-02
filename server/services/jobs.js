import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { folderName } from '../lib/slug.js';
import { cleanArtistName, stripTitleNoise } from '../lib/text.js';
import { EXPORTS_DIR, TMP_DIR } from '../lib/paths.js';
import { searchYouTube, innertube, getVideoDetails } from './innertube.js';
import { findOfficialVideoViaGenius, geniusConfigured } from '../lib/genius.js';
import { ytSearch, downloadMedia, audioFormatArgs, videoFormatArgs, outputPath } from './ytdlp.js';
import {
  toMp3,
  remuxMp4,
  extractPcmEnvelope,
  envelopeCorrelation,
  findNewestMedia,
  probeHasVideoStream,
} from './ffmpeg.js';
import { rankCandidates, scoreCandidate } from './matcher.js';
import { enrichAlbumAndArtist, pickImage, spotifyConfigured } from './spotify.js';
import { downloadBinary, extFromUrl, packCmf, writeJson } from './cmf.js';

const jobs = new Map();

// Below this total score, or below this specific keyword-signal score, a
// video candidate is treated as "probably not actually the thing we
// wanted" (fan edit, cover, reaction, lyric video, etc.) rather than
// forced through as the best available option. `keywords` in particular is
// the strongest available signal for this today — see matcher.js's
// VIDEO_BONUS/VIDEO_PENALTY lists — since a fan-made or unofficial upload
// usually trips one of those penalty patterns even when its title/artist
// text otherwise matches well. Tune via env if your library's real score
// distribution (visible in each item's matchNotes.video.considered) calls
// for it.
const MIN_VIDEO_MATCH_SCORE = Number(process.env.MIN_VIDEO_MATCH_SCORE ?? 0.55);
const MIN_VIDEO_KEYWORD_SCORE = Number(process.env.MIN_VIDEO_KEYWORD_SCORE ?? 0.35);

// Runs `worker` over `items` with at most `limit` in flight at once.
// Each worker receives (item, index) — index matches the item's position
// in the original array, even though completion order may differ.
async function runPool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

// Picks a unique folder name for an item and reserves it in `usedFolders`.
// Called synchronously (no awaits) so concurrent pool workers can't race on
// the same name.
function resolveFolder(raw, usedFolders, index) {
  const title = stripTitleNoise(raw.title || 'Untitled');
  const author = cleanArtistName(raw.author, raw.channel, raw.raw_title || raw.title);
  let folder = folderName(title, author);
  if (usedFolders.has(folder)) folder = `${folder}_${index}`;
  usedFolders.add(folder);
  return folder;
}

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
  const concurrency = Math.max(1, Number(process.env.JOB_CONCURRENCY || 3));

  const failed = [];
  await runPool(job.items, concurrency, async (raw, i) => {
    const index = i + 1;
    emit(job, {
      type: 'item',
      index,
      total: job.items.length,
      title: raw.title,
      message: `Resolving ${raw.title}`,
    });
    const folder = resolveFolder(raw, usedFolders, index);
    const itemDir = path.join(staged, folder);
    try {
      await processItem(job, raw, staged, folder, mode, index);
    } catch (err) {
      failed.push({ title: raw.title, error: err.message || String(err) });
      emit(job, {
        type: 'item_failed',
        index,
        title: raw.title,
        message: `Skipping ${raw.title}: ${err.message}`,
      });
      // Don't ship a half-written folder for a track that failed partway
      // (e.g. audio succeeded but every video candidate errored out).
      await fs.rm(itemDir, { recursive: true, force: true }).catch(() => {});
    }
  });

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
    failedItems: failed,
  });
  emit(job, { type: 'close' });
  for (const res of job.listeners) res.end();
  job.listeners.clear();

  fs.rm(work, { recursive: true, force: true }).catch(() => {});
}

async function processItem(job, raw, staged, folder, mode, index) {
  const title = stripTitleNoise(raw.title || 'Untitled');
  const author = cleanArtistName(raw.author, raw.channel, raw.raw_title || raw.title);

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

  // Shared by both video-skipped-entirely and video-download-failed paths
  // below: makes sure this item still ships with audio even though it was
  // requested with video.
  async function ensureAudioFallback(reasonMessage) {
    if (audioFile) return;
    await fs.mkdir(audioDir, { recursive: true });
    emit(job, { type: 'phase', item: index, phase: 'audio', message: reasonMessage });
    const audioPick = await pickSource(raw, { ...target, intent: 'audio' }, 'audio');
    matchNotes.audio = audioPick.note;
    await downloadMedia(audioPick.url, outputPath(tmpItem, 'audio_fallback'), audioFormatArgs(), (chunk) => {
      const line = String(chunk).trim().split('\n').pop();
      if (line) emit(job, { type: 'ytdlp', item: index, line });
    });
    const fallbackSrc = await findNewestMedia(tmpItem, 'audio_fallback');
    if (!fallbackSrc) {
      throw new Error(`No audio fallback source downloaded for ${title} after video match failed`);
    }
    const fallbackDest = path.join(audioDir, `${folder}.mp3`);
    await toMp3(fallbackSrc, fallbackDest);
    audioFile = fallbackDest;
    audioRel = `/${folder}/audio/${folder}.mp3`;
  }

  if (wantVideo) {
    emit(job, { type: 'phase', item: index, phase: 'video', message: 'Matching music video' });
    const videoPick = await pickVideoSource(raw, { ...target, intent: 'video' });

    if (videoPick.skip) {
      // Genius confirmed no official MV exists for this song — don't run it
      // through the search/download pipeline at all, just ship audio.
      emit(job, {
        type: 'log',
        message: `No official music video exists for ${title} (per Genius) — shipping audio only.`,
      });
      matchNotes.video = videoPick.note;
      await ensureAudioFallback('No music video exists for this song — falling back to audio source');
      // videoRel stays null — this item ships as audio-only. Fall through to
      // the shared cover-art/info.json code below (skip the rest of the
      // video search/download logic).
    } else {
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
          await Promise.all(
            top.map(async (row) => {
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
                if (!clip) return;
                const env = await extractPcmEnvelope(clip, 30);
                const wave = envelopeCorrelation(audioEnv, env);
                row.candidate.waveform = wave;
                row.score = scoreCandidate({ ...target, intent: 'video' }, row.candidate, wave);
              } catch (err) {
                emit(job, { type: 'log', message: `Waveform probe skipped: ${err.message}` });
              }
            }),
          );
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

      // Only trust candidates that look like they're actually the thing we
      // asked for. `keywords` specifically catches fan edits / covers /
      // reactions / lyric videos that VIDEO_PENALTY recognizes even when
      // title+artist text otherwise scores well.
      const qualifies = (r) =>
        r.score.total >= MIN_VIDEO_MATCH_SCORE && r.score.parts.keywords >= MIN_VIDEO_KEYWORD_SCORE;
      const qualifyingRanked = ranked.filter(qualifies);
      const bestScore = ranked[0]?.score.total ?? null;

      // Try candidates in ranked order (best first) until one actually
      // downloads a file with a real video stream — some "official music
      // video" search hits are audio-only uploads, which used to get
      // shipped as a video-extension file with no video frames.
      const candidateQueue = videoPick.forced
        ? [videoPick.candidate] // Genius already identified this as the MV — trust it, skip the score threshold
        : qualifyingRanked.length
          ? qualifyingRanked.map((r) => r.candidate)
          : ranked.length
            ? [] // nothing qualified — go straight to the audio fallback below
            : [videoPick.candidate]; // no ranked list at all (e.g. fallback_url strategy) — try the one pick we have
      const rejected = [];
      let src = null;
      let winningCandidate = null;
      for (let attempt = 0; attempt < candidateQueue.length; attempt++) {
        const candidate = candidateQueue[attempt];
        const attemptDir = path.join(tmpItem, `video_try_${attempt}`);
        await fs.mkdir(attemptDir, { recursive: true });
        emit(job, {
          type: 'phase',
          item: index,
          phase: 'video',
          message: `Downloading video: ${candidate.url}`,
        });
        try {
          await downloadMedia(candidate.url, outputPath(attemptDir, 'video'), videoFormatArgs(), (chunk) => {
            const line = String(chunk).trim().split('\n').pop();
            if (line) emit(job, { type: 'ytdlp', item: index, line });
          });
        } catch (err) {
          rejected.push({ url: candidate.url, reason: `download_error: ${String(err.message || err).slice(0, 200)}` });
          emit(job, { type: 'log', message: `Video download failed for ${candidate.url}: ${err.message}` });
          continue;
        }
        const downloaded = await findNewestMedia(attemptDir, 'video');
        if (!downloaded) {
          rejected.push({ url: candidate.url, reason: 'download_failed' });
          continue;
        }
        const hasVideo = await probeHasVideoStream(downloaded);
        if (!hasVideo) {
          rejected.push({ url: candidate.url, reason: 'no_video_stream' });
          emit(job, {
            type: 'log',
            message: `Rejected audio-only candidate for video: ${candidate.url}`,
          });
          continue;
        }
        src = downloaded;
        winningCandidate = candidate;
        break;
      }

      if (!src) {
        // No confident candidate at all, every confident candidate failed to
        // actually download/produce a video stream, or (forced case) the
        // single Genius-identified video itself failed to download — rather
        // than aborting the item (or, worse, shipping a low-confidence fan
        // video/cover as "the video"), fall back to the plain audio/song
        // source. If audio mode wasn't requested for this item, fetch it now.
        const reason = videoPick.forced
          ? 'genius_video_download_failed'
          : qualifyingRanked.length
            ? 'download_failed_all_candidates'
            : 'no_confident_video_match';
        emit(job, {
          type: 'log',
          message: `No usable video for ${title} (${reason}, best score ${bestScore != null ? bestScore.toFixed(2) : 'n/a'}) — falling back to audio source.`,
        });
        matchNotes.video = {
          ...matchNotes.video,
          fallback_to_audio: true,
          fallback_reason: reason,
          best_rejected_score: bestScore,
          rejected: rejected.length ? rejected : undefined,
        };

        await ensureAudioFallback('No confident video match — falling back to audio source');
        // videoRel stays null — this item ships as audio-only.
      } else {
        if (winningCandidate && winningCandidate !== videoPick.candidate) {
          videoPick.url = winningCandidate.url;
          matchNotes.video = { ...matchNotes.video, fallback_candidate: winningCandidate.url };
        }
        if (rejected.length) {
          matchNotes.video = { ...matchNotes.video, rejected_audio_only: rejected };
        }

        const dest = path.join(videoDir, `${folder}.mp4`);
        await remuxMp4(src, dest);
        videoRel = `/${folder}/video/${folder}.mp4`;
      }
    } // end videoPick.skip / weighted-search else branch
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
      ? `${target.author} ${target.title}`
      : `${target.author} ${target.title}`;

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

// Video-only entry point. Prefers Genius (see server/lib/genius.js) over
// the weighted YouTube search below — a Genius song page's YouTube media
// links, filtered to non-"- Topic" channels, are a stronger "does an MV
// exist, and which upload is it" signal than free-text search scoring.
//
// Three outcomes:
//  - Genius can't help (not configured, no song match, no YouTube media,
//    or a request failed) -> unchanged weighted-search fallback below.
//  - Genius confirms no MV exists (every linked upload is "- Topic") ->
//    `{ skip: true }`; the caller skips video entirely for this item.
//  - Genius points at a specific non-Topic video -> `{ forced: true, ... }`;
//    the caller downloads that candidate directly, bypassing the match-score
//    threshold, but still through the normal download/probe/reject pipeline.
async function pickVideoSource(raw, target) {
  const query = `${target.author} ${target.title}`;

  if (!geniusConfigured()) {
    return pickSource(raw, target, 'video');
  }

  let genius = null;
  try {
    genius = await findOfficialVideoViaGenius(query, { innertube });
  } catch {
    genius = null; // any Genius/Innertube error is treated as "couldn't help"
  }

  if (genius?.noMV) {
    return {
      skip: true,
      note: { strategy: 'genius', query, genius: genius.genius, result: 'no_mv_confirmed' },
    };
  }

  const top = genius?.results?.top;
  if (top?.videoId) {
    const url = `https://www.youtube.com/watch?v=${top.videoId}`;
    const details = await getVideoDetails(top.videoId).catch(() => null);
    const candidate = details || {
      title: top.title,
      author: target.author,
      channel: top.channel,
      raw_title: top.title,
      duration_ms: null,
      url,
      youtube_id: top.videoId,
    };
    return {
      url: candidate.url,
      candidate,
      forced: true,
      ranked: [],
      note: { strategy: 'genius', query, genius: genius.genius, videoId: top.videoId, channel: top.channel },
    };
  }

  // genius === null, or genius.noMV === false with no surviving top
  // candidate (an MV may exist but Genius only linked "- Topic" uploads
  // for it) — fall back to the existing weighted YouTube search unchanged.
  const fallback = await pickSource(raw, target, 'video');
  fallback.note = {
    ...fallback.note,
    genius_checked: true,
    genius_fallback_reason: genius ? 'no_qualifying_genius_candidate' : 'no_genius_match',
  };
  return fallback;
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