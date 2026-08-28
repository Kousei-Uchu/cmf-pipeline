import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import { sha256 } from '../lib/hash.js';

/**
 * Pack a directory of item folders into a .cmf (zip). Skip files whose
 * content hash was already added (shared album art, artist images, etc.).
 */
export function packCmf(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const skipped = [];
    const written = [];
    const seen = new Set();

    out.on('close', () => resolve({ bytes: archive.pointer(), skipped, written }));
    archive.on('error', reject);
    archive.pipe(out);

    (async () => {
      await walkAndAppend(sourceDir, '', archive, seen, skipped, written);
      await archive.finalize();
    })().catch(reject);
  });
}

async function walkAndAppend(abs, rel, archive, seen, skipped, written) {
  const entries = await fs.readdir(abs, { withFileTypes: true });
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
      skipped.push({ path: childRel, hash });
      continue;
    }
    seen.add(hash);
    written.push({ path: childRel, hash, bytes: buf.length });
    archive.append(buf, { name: childRel });
  }
}

export async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function downloadBinary(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Asset download failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  return buf;
}

export function extFromUrl(url, fallback = '.jpg') {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.(jpe?g|png|webp|gif|avif)$/i);
    if (m) return m[0].toLowerCase() === '.jpeg' ? '.jpg' : m[0].toLowerCase();
  } catch {
    // ignore
  }
  return fallback;
}
