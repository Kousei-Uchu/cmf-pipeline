import { inspect } from 'node:util';

/**
 * Central logger.
 *
 * Level is controlled by LOG_LEVEL=error|warn|info|debug (default "info").
 * DEBUG=1 is a shorthand for LOG_LEVEL=debug.
 *
 * In "debug" mode every module below emits a full trace: function entry/exit,
 * external process argv, HTTP requests, timings, decisions, and payload
 * shapes. Secrets (tokens, client secrets, auth headers) are always redacted
 * regardless of level.
 *
 * IMPORTANT: the level is read from process.env on every call rather than
 * cached at module-load time. index.js loads .env via dotenv *after* its
 * first imports run (imports are hoisted/evaluated before any code in the
 * importing file), so anything cached at import time here would permanently
 * see the pre-.env environment and silently ignore LOG_LEVEL from .env.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevelName() {
  const raw = (process.env.LOG_LEVEL || (process.env.DEBUG ? 'debug' : 'info')).toLowerCase();
  return LEVELS[raw] != null ? raw : 'info';
}

export function getLogLevel() {
  return currentLevelName();
}

export function isDebugEnabled() {
  return LEVELS[currentLevelName()] >= LEVELS.debug;
}

let seq = 0;

const SECRET_KEYS = /^(authorization|token|access_token|client_secret|client_id|password|secret|cookie|set-cookie)$/i;

function redact(value, depth = 0) {
  if (value == null || depth > 5) return value;
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) {
    return `${value.slice(0, 2000)}… [${value.length} chars total]`;
  }
  return value;
}

function fmt(level, ns, id, msg, meta) {
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${ns}] #${id} ${msg}`;
  if (meta !== undefined) {
    line += ' ' + inspect(redact(meta), { depth: 6, breakLength: 120, colors: false });
  }
  return line;
}

function write(level, ns, msg, meta) {
  if (LEVELS[level] > LEVELS[currentLevelName()]) return null;
  const id = (++seq).toString(36).padStart(4, '0');
  const resolvedMeta = typeof meta === 'function' ? meta() : meta;
  const line = fmt(level, ns, id, msg, resolvedMeta);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return id;
}

/**
 * Namespaced logger. Every server module gets its own `child(ns)` so trace
 * lines can be filtered/grepped by component (e.g. `[ytdlp]`, `[jobs]`).
 *
 * `meta` may be a plain object or a zero-arg function; pass a function for
 * anything expensive to build (e.g. per-candidate score breakdowns in a
 * scoring loop) so it's only computed when debug level is actually active.
 */
export function child(ns) {
  return {
    ns,
    error: (msg, meta) => write('error', ns, msg, meta),
    warn: (msg, meta) => write('warn', ns, msg, meta),
    info: (msg, meta) => write('info', ns, msg, meta),
    debug: (msg, meta) => write('debug', ns, msg, meta),
    /**
     * Start a timed span. Returns a function you call when the span ends;
     * it logs elapsed ms at debug level (plus any meta you pass it) and
     * returns the elapsed ms in case the caller wants it too.
     */
    time(label, startMeta) {
      if (!isDebugEnabled()) return () => 0;
      const start = process.hrtime.bigint();
      write('debug', ns, `${label} :: start`, startMeta);
      return (endMeta) => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        write('debug', ns, `${label} :: done in ${ms.toFixed(1)}ms`, endMeta);
        return ms;
      };
    },
  };
}

export default { child, getLogLevel, isDebugEnabled };
