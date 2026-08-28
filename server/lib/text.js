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
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function stripTitleNoise(title) {
  let t = String(title || '');
  t = t.replace(/\s*[\[(][^)\]]*(official|audio|video|lyric|visualizer|hd|4k|topic)[^)\]]*[\])]\s*/gi, ' ');
  for (const re of NOISE) t = t.replace(re, ' ');
  t = t.replace(/\s*[-–—]\s*$/g, '');
  return t.replace(/\s+/g, ' ').trim() || String(title || '').trim();
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
  }
  return name || 'Unknown Artist';
}

export function parseArtistTitle(rawTitle, channel) {
  const title = String(rawTitle || '').trim();
  const parts = title.split(/\s[-–—]\s/);
  if (parts.length >= 2 && !/topic/i.test(parts[0])) {
    return {
      author: cleanArtistName(parts[0], channel, title),
      title: stripTitleNoise(parts.slice(1).join(' - ')),
    };
  }
  return {
    author: cleanArtistName(channel, channel, title),
    title: stripTitleNoise(title),
  };
}

export function diceCoefficient(a, b) {
  const s1 = normalizeText(a);
  const s2 = normalizeText(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0;
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
  return (2 * overlap) / (s1.length - 1 + (s2.length - 1));
}

export function durationScore(expectedSec, actualSec, window = 12) {
  if (!expectedSec || !actualSec) return 0.35;
  const delta = Math.abs(expectedSec - actualSec);
  if (delta <= 2) return 1;
  if (delta >= window) return 0;
  return 1 - delta / window;
}

export function parseIsoDuration(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!m) return null;
  return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0));
}

export function parseClockDuration(text) {
  if (text == null) return null;
  if (typeof text === 'number' && Number.isFinite(text)) return text;
  const s = String(text).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}
