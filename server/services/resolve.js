import {
  parseSpotifyUrl,
  resolveSpotifyRef,
  searchSpotify,
  spotifyConfigured,
} from './spotify.js';
import { parseYouTubeUrl, searchYouTube, getVideoDetails } from './innertube.js';
import { ytDlpJson, mapDump, ytSearch } from './ytdlp.js';
import { parseArtistTitle } from '../lib/text.js';

function looksLikeUrl(query) {
  return /^https?:\/\//i.test(query.trim()) || /^spotify:/i.test(query.trim());
}

function mapYtdlpToItem(dump) {
  const mapped = mapDump(dump);
  if (!mapped) return null;
  const parsed = parseArtistTitle(mapped.title, mapped.author);
  return {
    id: mapped.youtube_id ? `youtube:${mapped.youtube_id}` : mapped.id,
    source: mapped.extractor === 'youtube' ? 'youtube' : 'ytdlp',
    type: mapped.type === 'playlist' ? 'playlist' : 'video',
    youtube_id: mapped.extractor === 'youtube' ? mapped.youtube_id : null,
    url: mapped.url,
    title: parsed.title,
    author: parsed.author,
    raw_title: mapped.title,
    channel: mapped.channel,
    duration_ms: mapped.duration_ms,
    thumbnail: mapped.thumbnail,
    extractor: mapped.extractor,
    entries: mapped.entries,
  };
}

export async function searchPipeline(query) {
  const q = String(query || '').trim();
  if (!q) {
    return { query: q, kind: 'empty', items: [], groups: [] };
  }

  if (looksLikeUrl(q)) {
    return resolveUrl(q);
  }

  const groups = [];
  const items = [];

  const [yt, sp] = await Promise.allSettled([
    searchYouTube(q),
    spotifyConfigured() ? searchSpotify(q) : Promise.resolve(null),
  ]);

  if (yt.status === 'fulfilled') {
    const music = yt.value.music || [];
    const videos = yt.value.videos || yt.value.items || [];
    if (music.length) {
      groups.push({ id: 'ytm', label: 'YouTube Music', items: music });
      items.push(...music);
    }
    if (videos.length) {
      const unique = videos.filter((v) => !music.some((m) => m.youtube_id === v.youtube_id));
      groups.push({ id: 'yt', label: 'YouTube', items: unique.slice(0, 16) });
      items.push(...unique.slice(0, 16));
    }
  } else {
    try {
      const fallback = await ytSearch(q, 10);
      const mapped = fallback.map(mapYtdlpToItem).filter(Boolean);
      groups.push({ id: 'yt', label: 'YouTube (yt-dlp)', items: mapped });
      items.push(...mapped);
    } catch {
      groups.push({
        id: 'yt',
        label: 'YouTube',
        error: yt.reason?.message || 'Innertube search failed',
        items: [],
      });
    }
  }

  if (sp.status === 'fulfilled' && sp.value) {
    if (sp.value.tracks.length) {
      groups.push({ id: 'sp-tracks', label: 'Spotify tracks', items: sp.value.tracks });
      items.push(...sp.value.tracks);
    }
    if (sp.value.albums.length) {
      groups.push({ id: 'sp-albums', label: 'Spotify albums', items: sp.value.albums });
    }
    if (sp.value.playlists.length) {
      groups.push({ id: 'sp-playlists', label: 'Spotify playlists', items: sp.value.playlists });
    }
    if (sp.value.artists.length) {
      groups.push({ id: 'sp-artists', label: 'Spotify artists', items: sp.value.artists });
    }
  } else if (sp.status === 'rejected') {
    groups.push({
      id: 'spotify',
      label: 'Spotify',
      error: sp.reason?.message || 'Spotify search failed',
      items: [],
    });
  }

  return { query: q, kind: 'search', items, groups };
}

export async function resolveUrl(url) {
  const spotify = parseSpotifyUrl(url);
  if (spotify) {
    if (!spotifyConfigured()) {
      throw Object.assign(new Error('Spotify URL provided but SPOTIFY_CLIENT_ID/SECRET are not set.'), {
        status: 400,
      });
    }
    const resolved = await resolveSpotifyRef(spotify);
    return {
      query: url,
      kind: 'url',
      source: 'spotify',
      collection: resolved.collection || null,
      collection_kind: resolved.kind,
      title: resolved.title,
      items: resolved.items,
      groups: [{ id: 'spotify', label: resolved.title, items: resolved.items }],
    };
  }

  const yt = parseYouTubeUrl(url);
  if (yt?.kind === 'video') {
    try {
      const details = await getVideoDetails(yt.id);
      return {
        query: url,
        kind: 'url',
        source: 'youtube',
        items: [details],
        groups: [{ id: 'youtube', label: details.title, items: [details] }],
      };
    } catch {
      // fall through to yt-dlp
    }
  }

  const dump = await ytDlpJson(url);
  if (dump._type === 'playlist' || Array.isArray(dump.entries)) {
    const entries = (dump.entries || []).map(mapYtdlpToItem).filter(Boolean);
    return {
      query: url,
      kind: 'url',
      source: 'ytdlp',
      title: dump.title,
      items: entries,
      groups: [{ id: 'playlist', label: dump.title || 'Playlist', items: entries }],
    };
  }
  const item = mapYtdlpToItem(dump);
  return {
    query: url,
    kind: 'url',
    source: 'ytdlp',
    items: item ? [item] : [],
    groups: [{ id: 'media', label: item?.title || 'Media', items: item ? [item] : [] }],
  };
}

export async function expandItem(source, type, id) {
  if (source === 'spotify') {
    return resolveSpotifyRef({ type, id });
  }
  if (source === 'youtube' && type === 'video') {
    const details = await getVideoDetails(id);
    return { kind: 'tracks', title: details.title, items: [details] };
  }
  throw new Error('Cannot expand this item');
}
