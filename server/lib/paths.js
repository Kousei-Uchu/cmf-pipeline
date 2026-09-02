import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { child } from './logger.js';

const log = child('paths');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '../..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const TMP_DIR = path.join(ROOT, 'tmp');
export const EXPORTS_DIR = path.join(ROOT, 'exports');

log.debug('resolved paths', { ROOT, PUBLIC_DIR, TMP_DIR, EXPORTS_DIR });
