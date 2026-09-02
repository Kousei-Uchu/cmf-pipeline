// Genius-driven official music video lookup.
//
// A Genius song page lists "media" links (YouTube, SoundCloud, etc.) its
// editors have attached to that song. We use the YouTube entries there —
// filtered to non-"- Topic" channels, since a "<Artist> - Topic" upload is
// YouTube's auto-generated audio track, never an actual video — as a
// higher-trust source for "does an official MV exist, and if so which
// upload is it" than free-text YouTube search.
//
// See README.md for the GENIUS_ACCESS_TOKEN setup step. This module is
// optional: geniusConfigured() reports whether a token is present, and
// findOfficialVideoViaGenius() itself returns null (not a throw) whenever
// Genius can't help, so callers can always fall back to a plain YouTube
// search.
import { child } from './logger.js';

const log = child('genius');

const GENIUS_SEARCH_URL = 'https://api.genius.com/search';
const GENIUS_SONG_URL = 'https://api.genius.com/songs';

export function geniusConfigured() {
  return Boolean(process.env.GENIUS_ACCESS_TOKEN);
}

async function geniusSearch(query, token) {
  const res = await fetch(`${GENIUS_SEARCH_URL}?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Genius search failed: ${res.status}`);
  const json = await res.json();
  return json.response?.hits ?? [];
}

async function geniusSong(id, token) {
  const res = await fetch(`${GENIUS_SONG_URL}/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Genius song lookup failed: ${res.status}`);
  const json = await res.json();
  return json.response?.song;
}

function extractYoutubeId(url = '') {
  const m = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/**
 * Looks up `query` on Genius and, if the matched song page lists YouTube
 * media, resolves those links via Innertube to decide whether a real music
 * video exists.
 *
 * `innertube` is an async getter returning an Innertube client (pass the
 * `innertube()` export from services/innertube.js) — injected rather than
 * imported directly so this lib/ module doesn't reach into services/.
 *
 * Returns null when Genius can't help at all: no token configured, no
 * search hit, the request failed, or the matched song has no YouTube media
 * — callers should treat that the same as "fall back to YouTube search".
 *
 * Otherwise resolves to:
 *   {
 *     noMV: boolean,        // true = every YouTube link Genius has for this
 *                           // song is a "- Topic" channel, i.e. no MV exists
 *     results: {
 *       all: [...],         // every YouTube link Genius listed, resolved
 *       filtered: [...],    // `all` minus "- Topic" channels
 *       top: filtered[0] ?? null,
 *     },
 *     genius: { url, fullTitle },  // the matched Genius page, for logging
 *   }
 */
export async function findOfficialVideoViaGenius(query, { innertube } = {}) {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) return null;
  if (typeof innertube !== 'function') {
    throw new Error('findOfficialVideoViaGenius requires an innertube() getter');
  }

  let hits;
  try {
    hits = await geniusSearch(query, token);
  } catch (err) {
    log.warn('genius search failed', { query, message: err.message });
    return null;
  }
  if (!hits.length) {
    log.debug('no Genius results', { query });
    return null;
  }

  const top = hits[0].result;
  log.debug('matched Genius page', { query, fullTitle: top.full_title, url: top.url });

  let song;
  try {
    song = await geniusSong(top.id, token);
  } catch (err) {
    log.warn('genius song lookup failed', { query, geniusUrl: top.url, message: err.message });
    return null;
  }

  const media = song?.media ?? [];
  const ytMedia = media.filter((m) => m.provider === 'youtube');
  if (!ytMedia.length) {
    log.debug('no YouTube entry in Genius media array', { query, geniusUrl: top.url });
    return null;
  }

  const yt = await innertube();
  const results = [];
  for (const m of ytMedia) {
    const videoId = extractYoutubeId(m.url);
    if (!videoId) continue;
    const info = await yt.getInfo(videoId).catch((err) => ({ error: err.message }));
    const channel = info.basic_info?.channel?.name ?? '';
    results.push({
      videoId,
      title: info.basic_info?.title,
      channel,
      isTopicChannel: /- Topic$/.test(channel),
    });
  }

  const filtered = results.filter((r) => !r.isTopicChannel);
  const noMV = filtered.length === 0 && results.length > 0;

  log.debug('genius media resolved', { query, noMV, resultCount: results.length, filteredCount: filtered.length });

  return {
    noMV,
    results: { all: results, filtered, top: filtered[0] ?? null },
    genius: { url: top.url, fullTitle: top.full_title },
  };
}