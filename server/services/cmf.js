import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import { sha256 } from '../lib/hash.js';
import { child } from '../lib/logger.js';

const log = child('cmf');

/**
 * Pack a directory of item folders into a .cmf (zip). Skip files whose
 * content hash was already added (shared album art, artist images, etc.).
 */
export function packCmf(sourceDir, outputPath) {
  log.debug('packCmf: start', { sourceDir, outputPath });
  const end = log.time('packCmf', { sourceDir, outputPath });
  return new Promise((resolve, reject) => {
    const out = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const skipped = [];
    const written = [];
    const seen = new Set();

    out.on('close', () => {
      const bytes = archive.pointer();
      end({ bytes, filesWritten: written.length, filesSkipped: skipped.length });
      resolve({ bytes, skipped, written });
    });
    archive.on('warning', (warn) => log.warn('packCmf: archiver warning', { message: warn.message }));
    archive.on('error', (err) => {
      log.error('packCmf: archiver error', { message: err.message });
      reject(err);
    });
    archive.pipe(out);

    (async () => {
      await walkAndAppend(sourceDir, '', archive, seen, skipped, written);
      log.debug('packCmf: finalizing archive', { filesWritten: written.length, filesSkipped: skipped.length });
      await archive.finalize();
    })().catch(reject);
  });
}

async function walkAndAppend(abs, rel, archive, seen, skipped, written) {
  const entries = await fs.readdir(abs, { withFileTypes: true });
  log.debug('walkAndAppend: reading directory', { abs, rel: rel || '(root)', entryCount: entries.length });
  for (const entry of entries) {
    const childAbs = path.join(abs, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkAndAppend(childAbs, childRel, archive, seen, skipped, written);
      continue;
    }
    const buf = await fs.readFile(childAbs);
    const hash = sha256(buf);
    if (seen.has(hash)) {
      log.debug('walkAndAppend: skipping duplicate content', { path: childRel, hash });
      skipped.push({ path: childRel, hash });
      continue;
    }
    seen.add(hash);
    written.push({ path: childRel, hash, bytes: buf.length });
    log.debug('walkAndAppend: appending to archive', { path: childRel, bytes: buf.length, hash });
    archive.append(buf, { name: childRel });
  }
}

export async function writeJson(filePath, data) {
  log.debug('writeJson', { filePath });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function downloadBinary(url, destPath) {
  log.debug('downloadBinary: start', { url, destPath });
  const end = log.time('downloadBinary', { url });
  const res = await fetch(url);
  log.debug('downloadBinary: response', { url, status: res.status, ok: res.ok });
  if (!res.ok) {
    end({ failed: true, status: res.status });
    throw new Error(`Asset download failed ${res.status} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  end({ bytes: buf.length });
  return buf;
}

export function extFromUrl(url, fallback = '.jpg') {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.(jpe?g|png|webp|gif|avif)$/i);
    if (m) {
      const ext = m[0].toLowerCase() === '.jpeg' ? '.jpg' : m[0].toLowerCase();
      log.debug('extFromUrl', { url, ext });
      return ext;
    }
  } catch (err) {
    log.debug('extFromUrl: URL parse failed, using fallback', { url, fallback, message: err.message });
  }
  log.debug('extFromUrl: no match, using fallback', { url, fallback });
  return fallback;
}
