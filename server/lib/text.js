import { child } from './logger.js';

const log = child('text');

const NOISE = [
  /official\s*(music\s*)?video/gi,
  /official\s*audio/gi,
  /official\s*lyric\s*video/gi,
  /lyric\s*video/gi,
  /visualizer/gi,
  /audio\s*only/gi,
  /hq\s*audio/gi,
  /topic/gi,
  /remaster(ed)?(\s*\d{2,4})?/gi,
  /\bhd\b/gi,
  /\b4k\b/gi,
  /\blyrics?\b/gi,
  /\(explicit\)/gi,
  /\[explicit\]/gi,
];

export function normalizeText(value) {
  const result = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  log.debug('normalizeText', () => ({ input: value, result }));
  return result;
}

export function stripTitleNoise(title) {
  let t = String(title || '');
  t = t.replace(/\s*[\[(][^)\]]*(official|audio|video|lyric|visualizer|hd|4k|topic)[^)\]]*[\])]\s*/gi, ' ');
  for (const re of NOISE) t = t.replace(re, ' ');
  t = t.replace(/\s*[-–—]\s*$/g, '');
  const result = t.replace(/\s+/g, ' ').trim() || String(title || '').trim();
  log.debug('stripTitleNoise', { input: title, result });
  return result;
}

/**
 * YouTube Music auto-generated uploads often surface as "Artist - Topic"
 * in the channel, and "Song (Official Audio)" in the title. Prefer a real artist name.
 */
export function cleanArtistName(artist, channel, title) {
  let name = String(artist || channel || '').trim();
  name = name.replace(/\s*-\s*topic$/i, '').trim();
  name = name.replace(/\s*vevo$/i, '').trim();

  if (!name || /^topic$/i.test(name) || /provided to youtube/i.test(name)) {
    const fromTitle = String(title || '').split(/\s[-–—]\s/)[0];
    name = stripTitleNoise(fromTitle);
    log.debug('cleanArtistName: fell back to title-derived name', { artist, channel, title, name });
  }
  const result = name || 'Unknown Artist';
  log.debug('cleanArtistName', { artist, channel, title, result });
  return result;
}

export function parseArtistTitle(rawTitle, channel) {
  const title = String(rawTitle || '').trim();
  const parts = title.split(/\s[-–—]\s/);
  let result;
  if (parts.length >= 2 && !/topic/i.test(parts[0])) {
    result = {
      author: cleanArtistName(parts[0], channel, title),
      title: stripTitleNoise(parts.slice(1).join(' - ')),
    };
  } else {
    result = {
      author: cleanArtistName(channel, channel, title),
      title: stripTitleNoise(title),
    };
  }
  log.debug('parseArtistTitle', { rawTitle, channel, result });
  return result;
}

export function diceCoefficient(a, b) {
  const s1 = normalizeText(a);
  const s2 = normalizeText(b);
  let score;
  if (!s1 || !s2) {
    score = 0;
  } else if (s1 === s2) {
    score = 1;
  } else if (s1.length < 2 || s2.length < 2) {
    score = s1 === s2 ? 1 : 0;
  } else {
    const bigrams = new Map();
    for (let i = 0; i < s1.length - 1; i++) {
      const g = s1.slice(i, i + 2);
      bigrams.set(g, (bigrams.get(g) || 0) + 1);
    }
    let overlap = 0;
    for (let i = 0; i < s2.length - 1; i++) {
      const g = s2.slice(i, i + 2);
      const n = bigrams.get(g) || 0;
      if (n > 0) {
        bigrams.set(g, n - 1);
        overlap++;
      }
    }
    score = (2 * overlap) / (s1.length - 1 + (s2.length - 1));
  }
  log.debug('diceCoefficient', () => ({ a, b, score }));
  return score;
}

export function durationScore(expectedSec, actualSec, window = 120) {
  let score;
  if (!expectedSec || !actualSec) {
    score = 0.35;
  } else {
    const delta = Math.abs(expectedSec - actualSec);
    if (delta <= 2) score = 1;
    else if (delta >= window) score = 0;
    else score = 1 - delta / window;
  }
  log.debug('durationScore', { expectedSec, actualSec, window, score });
  return score;
}

export function parseIsoDuration(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!m) {
    log.debug('parseIsoDuration: no match', { iso });
    return null;
  }
  const seconds = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  log.debug('parseIsoDuration', { iso, seconds });
  return seconds;
}

export function parseClockDuration(text) {
  if (text == null) return null;
  if (typeof text === 'number' && Number.isFinite(text)) return text;
  const s = String(text).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) {
    log.debug('parseClockDuration: unparseable', { text });
    return null;
  }
  let seconds = null;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  log.debug('parseClockDuration', { text, seconds });
  return seconds;
}
