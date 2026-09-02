import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { child } from './logger.js';

const log = child('hash');

export function sha256(buffer) {
  const digest = createHash('sha256').update(buffer).digest('hex');
  log.debug('sha256(buffer)', { bytes: buffer.length, digest });
  return digest;
}

export async function sha256File(filePath) {
  log.debug('sha256File: reading', { filePath });
  const buf = await readFile(filePath);
  const digest = sha256(buf);
  log.debug('sha256File: done', { filePath, bytes: buf.length, digest });
  return digest;
}
