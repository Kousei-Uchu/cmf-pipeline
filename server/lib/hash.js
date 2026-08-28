import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function sha256File(filePath) {
  const buf = await readFile(filePath);
  return sha256(buf);
}
