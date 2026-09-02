import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load .env FIRST, before importing any other local module. ES module
// imports are evaluated before the importing file's own top-level code runs,
// so if dotenv.config() happened after `import './lib/paths.js'` etc., every
// module-load-time log line (and anything else reading process.env at
// import time) would see the environment from *before* .env was parsed.
// Doing the path resolution locally here (rather than importing it from
// lib/paths.js) keeps this file free of any other local imports until after
// dotenv has run.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const [{ PUBLIC_DIR }, { api }, { child, getLogLevel, isDebugEnabled }, expressModule, cryptoModule] =
  await Promise.all([
    import('./lib/paths.js'),
    import('./routes/api.js'),
    import('./lib/logger.js'),
    import('express'),
    import('node:crypto'),
  ]);
const express = expressModule.default;
const crypto = cryptoModule.default;

const log = child('http');
const startupLog = child('startup');

startupLog.debug('env loaded', {
  envFile: path.join(ROOT, '.env'),
  LOG_LEVEL: getLogLevel(),
  PORT: process.env.PORT,
  HOST: process.env.HOST,
  YTDLP_PATH: process.env.YTDLP_PATH || '(default: yt-dlp on PATH)',
  FFMPEG_PATH: process.env.FFMPEG_PATH || '(default: ffmpeg on PATH)',
  spotifyConfigured: Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Request/response trace middleware. At debug level this logs every single
// request in and response out, with a shared request id so the two lines
// (and anything logged deeper in the pipeline) can be correlated.
app.use((req, res, next) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  req.requestId = requestId;
  const start = process.hrtime.bigint();
  log.debug(`--> ${req.method} ${req.originalUrl}`, () => ({
    requestId,
    query: req.query,
    body: req.method !== 'GET' ? req.body : undefined,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  }));
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'warn' : 'debug';
    log[level](`<-- ${req.method} ${req.originalUrl} ${res.statusCode} in ${ms.toFixed(1)}ms`, {
      requestId,
    });
  });
  next();
});

app.use(express.static(PUBLIC_DIR));
app.use('/api', api);

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  log.error(`unhandled error on ${req?.method} ${req?.originalUrl}`, {
    requestId: req?.requestId,
    status,
    message: err.message,
    stack: err.stack,
  });
  res.status(status).json({ error: err.message || 'Internal error' });
});

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

app.listen(port, host, () => {
  console.log(`cmf-pipeline  http://${host}:${port}`);
  console.log(`search API    http://${host}:${port}/api/search?query=`);
  startupLog.info('server listening', { host, port, logLevel: getLogLevel(), debugTraceEnabled: isDebugEnabled() });
  if (isDebugEnabled()) {
    startupLog.debug('DEBUG logging is ON — expect a full trace of requests, subprocess calls, HTTP calls, and job internals');
  }
});