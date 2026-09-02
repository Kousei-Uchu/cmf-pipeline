import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { searchPipeline, expandItem } from '../services/resolve.js';
import { createJob, getJob, attachSse, detachSse } from '../services/jobs.js';
import { whichVersion } from '../lib/spawn.js';
import { spotifyConfigured } from '../services/spotify.js';
import { EXPORTS_DIR } from '../lib/paths.js';
import { child } from '../lib/logger.js';

const log = child('api');

export const api = express.Router();

// Job metadata lives in memory and doesn't survive a restart, but the
// packed .cmf files themselves do — they're written to EXPORTS_DIR as
// `${job.id}.cmf` and only pruned by the in-process TTL sweep. So if a
// job id isn't in memory anymore, check whether that file still exists on
// disk before giving up. We lose the original human-readable fileName and
// skipped-item list in that case, but the archive itself is still valid.
async function resolveExport(id) {
  const job = getJob(id);
  if (job?.filePath) {
    return { filePath: job.filePath, fileName: job.fileName || 'library.cmf', fromDisk: false };
  }
  const diskPath = path.join(EXPORTS_DIR, `${id}.cmf`);
  try {
    await fs.access(diskPath);
    return { filePath: diskPath, fileName: `library_${id}.cmf`, fromDisk: true };
  } catch {
    return null;
  }
}

api.get('/health', async (req, res) => {
  log.debug('GET /health: checking yt-dlp/ffmpeg/spotify status', { requestId: req.requestId });
  const ytdlp = await whichVersion(process.env.YTDLP_PATH || 'yt-dlp');
  const ffmpeg = await whichVersion(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']);
  const payload = {
    ok: Boolean(ytdlp && ffmpeg),
    ytdlp,
    ffmpeg,
    spotify: spotifyConfigured(),
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 8787),
  };
  log.debug('GET /health: result', { requestId: req.requestId, ...payload });
  res.json(payload);
});

api.get('/search', async (req, res, next) => {
  try {
    const query = String(req.query.query || req.query.q || '');
    log.debug('GET /search', { requestId: req.requestId, query });
    const result = await searchPipeline(query);
    log.debug('GET /search: responding', {
      requestId: req.requestId,
      kind: result.kind,
      itemCount: result.items?.length || 0,
      groupCount: result.groups?.length || 0,
    });
    res.json(result);
  } catch (err) {
    log.error('GET /search: failed', { requestId: req.requestId, message: err.message, stack: err.stack });
    next(err);
  }
});

api.get('/expand', async (req, res, next) => {
  try {
    const source = String(req.query.source || '');
    const type = String(req.query.type || '');
    const id = String(req.query.id || '');
    log.debug('GET /expand', { requestId: req.requestId, source, type, id });
    if (!source || !type || !id) {
      log.debug('GET /expand: missing required params', { requestId: req.requestId, source, type, id });
      res.status(400).json({ error: 'source, type, and id are required' });
      return;
    }
    const result = await expandItem(source, type, id);
    log.debug('GET /expand: responding', { requestId: req.requestId, itemCount: result.items?.length || 0 });
    res.json(result);
  } catch (err) {
    log.error('GET /expand: failed', { requestId: req.requestId, message: err.message, stack: err.stack });
    next(err);
  }
});

api.post('/jobs', async (req, res, next) => {
  try {
    const { items, mode, exportKind } = req.body || {};
    log.debug('POST /jobs', {
      requestId: req.requestId,
      itemCount: Array.isArray(items) ? items.length : 0,
      mode,
      exportKind,
    });
    if (!Array.isArray(items) || !items.length) {
      log.debug('POST /jobs: rejected — items[] missing/empty', { requestId: req.requestId });
      res.status(400).json({ error: 'items[] is required' });
      return;
    }
    const allowed = new Set(['audio', 'video', 'both']);
    if (!allowed.has(mode)) {
      log.debug('POST /jobs: rejected — invalid mode', { requestId: req.requestId, mode });
      res.status(400).json({ error: 'mode must be audio, video, or both' });
      return;
    }
    const job = await createJob({ items, mode, exportKind: exportKind || 'file' });
    log.debug('POST /jobs: job created', { requestId: req.requestId, jobId: job.id });
    res.status(202).json({ id: job.id, events: `/api/jobs/${job.id}/events` });
  } catch (err) {
    log.error('POST /jobs: failed', { requestId: req.requestId, message: err.message, stack: err.stack });
    next(err);
  }
});

api.get('/jobs/:id', async (req, res) => {
  log.debug('GET /jobs/:id', { requestId: req.requestId, jobId: req.params.id });
  const job = getJob(req.params.id);
  if (job) {
    res.json({
      id: job.id,
      status: job.status,
      error: job.error,
      fileName: job.fileName,
      download: job.filePath ? `/api/jobs/${job.id}/file` : null,
      exportUrl: job.exportUrlPath,
      skipped: job.skipped || [],
    });
    return;
  }
  const exp = await resolveExport(req.params.id);
  if (!exp) {
    log.debug('GET /jobs/:id: not found', { requestId: req.requestId, jobId: req.params.id });
    res.status(404).json({ error: 'job not found' });
    return;
  }
  // Job metadata didn't survive a restart, but the file did.
  res.json({
    id: req.params.id,
    status: 'done',
    error: null,
    fileName: exp.fileName,
    download: `/api/jobs/${req.params.id}/file`,
    exportUrl: `/api/export/${req.params.id}`,
    skipped: [],
    recoveredFromDisk: true,
  });
});

api.get('/jobs/:id/events', (req, res) => {
  log.debug('GET /jobs/:id/events: SSE client connecting', { requestId: req.requestId, jobId: req.params.id });
  const job = getJob(req.params.id);
  if (!job) {
    log.debug('GET /jobs/:id/events: job not found', { requestId: req.requestId, jobId: req.params.id });
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  attachSse(job, res);
  req.on('close', () => {
    log.debug('GET /jobs/:id/events: SSE client disconnected', { requestId: req.requestId, jobId: req.params.id });
    detachSse(job, res);
  });
});

api.get('/jobs/:id/file', async (req, res) => {
  log.debug('GET /jobs/:id/file', { requestId: req.requestId, jobId: req.params.id });
  const exp = await resolveExport(req.params.id);
  if (!exp) {
    log.debug('GET /jobs/:id/file: not ready', { requestId: req.requestId, jobId: req.params.id });
    res.status(404).json({ error: 'file not ready' });
    return;
  }
  log.debug('GET /jobs/:id/file: sending', {
    requestId: req.requestId,
    filePath: exp.filePath,
    fileName: exp.fileName,
    fromDisk: exp.fromDisk,
  });
  res.download(exp.filePath, exp.fileName);
});

api.get('/export/:id', async (req, res) => {
  log.debug('GET /export/:id', { requestId: req.requestId, jobId: req.params.id, format: req.query.format });
  const exp = await resolveExport(req.params.id);
  if (!exp) {
    log.debug('GET /export/:id: not found or expired', { requestId: req.requestId, jobId: req.params.id });
    res.status(404).json({ error: 'export not found or expired' });
    return;
  }
  if (req.query.format === 'dataurl') {
    const buf = await fs.readFile(exp.filePath);
    log.debug('GET /export/:id: dataurl requested', { requestId: req.requestId, bytes: buf.length });
    if (buf.length > 25 * 1024 * 1024) {
      log.debug('GET /export/:id: too large for dataurl', { requestId: req.requestId, bytes: buf.length });
      res.status(413).json({
        error: 'Archive is larger than 25MB; use the file download or export URL instead of a data URL.',
        bytes: buf.length,
        exportUrl: `/api/export/${req.params.id}`,
      });
      return;
    }
    res.json({
      mime: 'application/zip',
      filename: exp.fileName,
      data_url: `data:application/zip;base64,${buf.toString('base64')}`,
    });
    return;
  }
  log.debug('GET /export/:id: sending file', { requestId: req.requestId, filePath: exp.filePath });
  res.download(exp.filePath, exp.fileName);
});