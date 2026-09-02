import {
  parseSpotifyUrl,
  resolveSpotifyRef,
  searchSpotify,
  spotifyConfigured,
} from './spotify.js';
import { parseYouTubeUrl, searchYouTube, getVideoDetails } from './innertube.js';
import { ytDlpJson, mapDump, ytSearch } from './ytdlp.js';
import { parseArtistTitle } from '../lib/text.js';
import { child } from '../lib/logger.js';

const log = child('resolve');

function looksLikeUrl(query) {
  const result = /^https?:\/\//i.test(query.trim()) || /^spotify:/i.test(query.trim());
  log.debug('looksLikeUrl', { query, result });
  return result;
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
    view_count: mapped.view_count, // ← add this
    thumbnail: mapped.thumbnail,
    extractor: mapped.extractor,
    entries: mapped.entries,
  };
}

export async function searchPipeline(query) {
  const q = String(query || '').trim();
  log.debug('searchPipeline: start', { query: q });
  const end = log.time('searchPipeline', { query: q });
  if (!q) {
    log.debug('searchPipeline: empty query, short-circuiting');
    end({ kind: 'empty' });
    return { query: q, kind: 'empty', items: [], groups: [] };
  }

  if (looksLikeUrl(q)) {
    log.debug('searchPipeline: query looks like a URL, delegating to resolveUrl', { q });
    const result = await resolveUrl(q);
    end({ kind: 'url' });
    return result;
  }

  const groups = [];
  const items = [];

  log.debug('searchPipeline: querying YouTube (Innertube) and Spotify in parallel', {
    spotifyEnabled: spotifyConfigured(),
  });
  const [yt, sp] = await Promise.allSettled([
    searchYouTube(q),
    spotifyConfigured() ? searchSpotify(q) : Promise.resolve(null),
  ]);
  log.debug('searchPipeline: parallel search settled', {
    ytStatus: yt.status,
    spStatus: sp.status,
  });

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
    log.debug('searchPipeline: YouTube branch mapped', { musicCount: music.length, videoCount: videos.length });
  } else {
    log.warn('searchPipeline: Innertube search rejected, falling back to yt-dlp ytsearch', {
      message: yt.reason?.message,
    });
    try {
      const fallback = await ytSearch(q, 10);
      const mapped = fallback.map(mapYtdlpToItem).filter(Boolean);
      groups.push({ id: 'yt', label: 'YouTube (yt-dlp)', items: mapped });
      items.push(...mapped);
      log.debug('searchPipeline: yt-dlp fallback succeeded', { resultCount: mapped.length });
    } catch (err) {
      log.warn('searchPipeline: yt-dlp fallback also failed', { message: err.message });
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
    log.debug('searchPipeline: Spotify branch mapped', {
      tracks: sp.value.tracks.length,
      albums: sp.value.albums.length,
      playlists: sp.value.playlists.length,
      artists: sp.value.artists.length,
    });
  } else if (sp.status === 'rejected') {
    log.warn('searchPipeline: Spotify search rejected', { message: sp.reason?.message });
    groups.push({
      id: 'spotify',
      label: 'Spotify',
      error: sp.reason?.message || 'Spotify search failed',
      items: [],
    });
  }

  end({ groupCount: groups.length, itemCount: items.length });
  return { query: q, kind: 'search', items, groups };
}

export async function resolveUrl(url) {
  log.debug('resolveUrl: start', { url });
  const end = log.time('resolveUrl', { url });
  const spotify = parseSpotifyUrl(url);
  if (spotify) {
    log.debug('resolveUrl: matched Spotify URL', { spotify });
    if (!spotifyConfigured()) {
      end({ failed: true, reason: 'spotify_not_configured' });
      throw Object.assign(new Error('Spotify URL provided but SPOTIFY_CLIENT_ID/SECRET are not set.'), {
        status: 400,
      });
    }
    const resolved = await resolveSpotifyRef(spotify);
    end({ source: 'spotify', kind: resolved.kind, itemCount: resolved.items.length });
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
    log.debug('resolveUrl: matched YouTube video URL', { yt });
    try {
      const details = await getVideoDetails(yt.id);
      end({ source: 'youtube', kind: 'video' });
      return {
        query: url,
        kind: 'url',
        source: 'youtube',
        items: [details],
        groups: [{ id: 'youtube', label: details.title, items: [details] }],
      };
    } catch (err) {
      log.warn('resolveUrl: getVideoDetails failed, falling through to yt-dlp', { message: err.message });
      // fall through to yt-dlp
    }
  }

  log.debug('resolveUrl: falling back to yt-dlp for URL', { url });
  const dump = await ytDlpJson(url);
  if (dump._type === 'playlist' || Array.isArray(dump.entries)) {
    const entries = (dump.entries || []).map(mapYtdlpToItem).filter(Boolean);
    log.debug('resolveUrl: yt-dlp resolved a playlist', { url, entryCount: entries.length, title: dump.title });
    end({ source: 'ytdlp', kind: 'playlist', itemCount: entries.length });
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
  log.debug('resolveUrl: yt-dlp resolved a single item', { url, title: item?.title });
  end({ source: 'ytdlp', kind: 'single', found: Boolean(item) });
  return {
    query: url,
    kind: 'url',
    source: 'ytdlp',
    items: item ? [item] : [],
    groups: [{ id: 'media', label: item?.title || 'Media', items: item ? [item] : [] }],
  };
}

export async function expandItem(source, type, id) {
  log.debug('expandItem: start', { source, type, id });
  if (source === 'spotify') {
    return resolveSpotifyRef({ type, id });
  }
  if (source === 'youtube' && type === 'video') {
    const details = await getVideoDetails(id);
    return { kind: 'tracks', title: details.title, items: [details] };
  }
  log.warn('expandItem: unsupported source/type combination', { source, type, id });
  throw new Error('Cannot expand this item');
}
