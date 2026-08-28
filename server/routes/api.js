import express from 'express';
import { searchPipeline, expandItem } from '../services/resolve.js';
import { createJob, getJob, attachSse, detachSse } from '../services/jobs.js';
import { whichVersion } from '../lib/spawn.js';
import { spotifyConfigured } from '../services/spotify.js';

export const api = express.Router();

api.get('/health', async (_req, res) => {
  const ytdlp = await whichVersion(process.env.YTDLP_PATH || 'yt-dlp');
  const ffmpeg = await whichVersion(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']);
  res.json({
    ok: Boolean(ytdlp && ffmpeg),
    ytdlp,
    ffmpeg,
    spotify: spotifyConfigured(),
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 8787),
  });
});

api.get('/search', async (req, res, next) => {
  try {
    const query = String(req.query.query || req.query.q || '');
    const result = await searchPipeline(query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

api.get('/expand', async (req, res, next) => {
  try {
    const source = String(req.query.source || '');
    const type = String(req.query.type || '');
    const id = String(req.query.id || '');
    if (!source || !type || !id) {
      res.status(400).json({ error: 'source, type, and id are required' });
      return;
    }
    const result = await expandItem(source, type, id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

api.post('/jobs', async (req, res, next) => {
  try {
    const { items, mode, exportKind } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      res.status(400).json({ error: 'items[] is required' });
      return;
    }
    const allowed = new Set(['audio', 'video', 'both']);
    if (!allowed.has(mode)) {
      res.status(400).json({ error: 'mode must be audio, video, or both' });
      return;
    }
    const job = await createJob({ items, mode, exportKind: exportKind || 'file' });
    res.status(202).json({ id: job.id, events: `/api/jobs/${job.id}/events` });
  } catch (err) {
    next(err);
  }
});

api.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json({
    id: job.id,
    status: job.status,
    error: job.error,
    fileName: job.fileName,
    download: job.filePath ? `/api/jobs/${job.id}/file` : null,
    exportUrl: job.exportUrlPath,
    skipped: job.skipped || [],
  });
});

api.get('/jobs/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  attachSse(job, res);
  req.on('close', () => detachSse(job, res));
});

api.get('/jobs/:id/file', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.filePath) {
    res.status(404).json({ error: 'file not ready' });
    return;
  }
  res.download(job.filePath, job.fileName || 'library.cmf');
});

api.get('/export/:id', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.filePath) {
    res.status(404).json({ error: 'export not found or expired' });
    return;
  }
  if (req.query.format === 'dataurl') {
    const fs = await import('node:fs/promises');
    const buf = await fs.readFile(job.filePath);
    if (buf.length > 25 * 1024 * 1024) {
      res.status(413).json({
        error: 'Archive is larger than 25MB; use the file download or export URL instead of a data URL.',
        bytes: buf.length,
        exportUrl: `/api/export/${job.id}`,
      });
      return;
    }
    res.json({
      mime: 'application/zip',
      filename: job.fileName,
      data_url: `data:application/zip;base64,${buf.toString('base64')}`,
    });
    return;
  }
  res.download(job.filePath, job.fileName || 'library.cmf');
});
