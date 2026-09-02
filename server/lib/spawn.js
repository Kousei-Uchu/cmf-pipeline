import { spawn } from 'node:child_process';
import { child } from './logger.js';

const log = child('spawn');
let procSeq = 0;

/**
 * Run a process, collecting stdout/stderr. Rejects on non-zero exit.
 *
 * Full debug trace: the exact argv, cwd, timeout, every stdout/stderr chunk
 * (truncated if huge), exit code, duration, and — on failure — the captured
 * tail of output that produced the error.
 */
export function run(command, args, { cwd, timeoutMs = 0, onStdout, onStderr, binary = false } = {}) {
  const procId = `p${(++procSeq).toString(36)}`;
  const start = process.hrtime.bigint();

  log.debug(`[${procId}] spawn: ${command} ${args.join(' ')}`, {
    cwd: cwd || process.cwd(),
    timeoutMs,
    binary,
  });

  return new Promise((resolve, reject) => {
    const child_ = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.debug(`[${procId}] pid ${child_.pid} started`);

    const stdoutChunks = [];
    let stdout = '';
    let stderr = '';
    let stdoutChunkCount = 0;
    let stderrChunkCount = 0;
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            log.warn(`[${procId}] timed out after ${timeoutMs}ms, sending SIGKILL to pid ${child_.pid}`);
            child_.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child_.stdout.on('data', (chunk) => {
      stdoutChunkCount += 1;
      if (binary) {
        stdoutChunks.push(chunk);
        log.debug(`[${procId}] stdout chunk #${stdoutChunkCount} (${chunk.length} bytes, binary)`);
        onStdout?.(chunk);
      } else {
        const text = chunk.toString();
        stdout += text;
        log.debug(`[${procId}] stdout chunk #${stdoutChunkCount}`, () => ({ text: text.slice(0, 500) }));
        onStdout?.(text);
      }
    });
    child_.stderr.on('data', (chunk) => {
      stderrChunkCount += 1;
      const text = chunk.toString();
      stderr += text;
      log.debug(`[${procId}] stderr chunk #${stderrChunkCount}`, () => ({ text: text.slice(0, 500) }));
      onStderr?.(text);
    });
    child_.on('error', (err) => {
      if (timer) clearTimeout(timer);
      log.error(`[${procId}] failed to spawn ${command}`, { message: err.message });
      reject(err);
    });
    child_.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const stdoutBuf = binary ? Buffer.concat(stdoutChunks) : null;
      if (timedOut) {
        log.warn(`[${procId}] ${command} timed out after ${timeoutMs}ms (${ms.toFixed(1)}ms elapsed)`);
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const tail = stderr.slice(-4000) || (binary ? '' : stdout.slice(-4000));
        log.warn(`[${procId}] ${command} exited ${code} after ${ms.toFixed(1)}ms`, {
          stdoutChunks: stdoutChunkCount,
          stderrChunks: stderrChunkCount,
          tail: tail.slice(0, 1000),
        });
        const err = new Error(`${command} exited ${code}: ${tail}`);
        err.stdout = binary ? stdoutBuf : stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
        return;
      }
      log.debug(`[${procId}] ${command} exited 0 after ${ms.toFixed(1)}ms`, {
        stdoutBytes: binary ? stdoutBuf.length : stdout.length,
        stderrBytes: stderr.length,
      });
      resolve({ stdout: binary ? stdoutBuf : stdout, stderr, code });
    });
  });
}

export function whichVersion(command, args = ['--version']) {
  log.debug(`whichVersion: checking ${command} ${args.join(' ')}`);
  return run(command, args, { timeoutMs: 15000 })
    .then((r) => {
      const version = (r.stdout || r.stderr).trim().split('\n')[0];
      log.debug(`whichVersion: ${command} -> ${version}`);
      return version;
    })
    .catch((err) => {
      log.warn(`whichVersion: ${command} not found or failed`, { message: err.message });
      return null;
    });
}
