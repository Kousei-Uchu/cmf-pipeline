import { child } from './logger.js';

const log = child('slug');

export function slugify(value, fallback = 'item') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 80);
  const result = slug || fallback;
  log.debug('slugify', { input: value, fallback, result });
  return result;
}

export function folderName(title, author) {
  const name = `${slugify(title, 'untitled')}_${slugify(author, 'unknown')}`;
  log.debug('folderName', { title, author, name });
  return name;
}
