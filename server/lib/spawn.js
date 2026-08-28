import { spawn } from 'node:child_process';

/**
 * Run a process, collecting stdout/stderr. Rejects on non-zero exit.
 */
export function run(command, args, { cwd, timeoutMs = 0, onStdout, onStderr, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => {
      if (binary) {
        stdoutChunks.push(chunk);
        onStdout?.(chunk);
      } else {
        const text = chunk.toString();
        stdout += text;
        onStdout?.(text);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const stdoutBuf = binary ? Buffer.concat(stdoutChunks) : null;
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const tail = stderr.slice(-4000) || (binary ? '' : stdout.slice(-4000));
        const err = new Error(`${command} exited ${code}: ${tail}`);
        err.stdout = binary ? stdoutBuf : stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
        return;
      }
      resolve({ stdout: binary ? stdoutBuf : stdout, stderr, code });
    });
  });
}

export function whichVersion(command, args = ['--version']) {
  return run(command, args, { timeoutMs: 15000 })
    .then((r) => (r.stdout || r.stderr).trim().split('\n')[0])
    .catch(() => null);
}
