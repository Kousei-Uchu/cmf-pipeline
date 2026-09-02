import { Innertube } from 'youtubei.js';
import { parseClockDuration, parseArtistTitle, stripTitleNoise, cleanArtistName } from '../lib/text.js';
import { child } from '../lib/logger.js';

const log = child('innertube');

let clientPromise = null;

export async function innertube() {
  if (!clientPromise) {
    log.debug('innertube: no cached client, creating a new Innertube session');
    const end = log.time('Innertube.create');
    clientPromise = Innertube.create({
    })
      .then((client) => {
        end();
        log.debug('innertube: session ready');
        return client;
      })
      .catch((err) => {
        end({ failed: true });
        log.error('innertube: session creation failed', { message: err.message });
        clientPromise = null;
        throw err;
      });
  } else {
    log.debug('innertube: reusing cached client session');
  }
  return clientPromise;
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.toString === 'function') {
    const s = value.toString();
    if (s && s !== '[object Object]') return s;
  }
  return '';
}

function thumbUrl(thumbs) {
  if (!thumbs) return null;
  const list = Array.isArray(thumbs) ? thumbs : thumbs.contents || [];
  if (!list.length) return null;
  const best = [...list].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best?.url || null;
}

function videoIdOf(item) {
  return (
    item?.video_id ||
    (typeof item?.id === 'string' && /^[\w-]{11}$/.test(item.id) ? item.id : null) ||
    item?.endpoint?.payload?.videoId ||
    item?.endpoint?.metadata?.url?.match(/v=([\w-]{11})/)?.[1] ||
    null
  );
}

function asItem(item, type = 'video') {
  if (!item) return null;
  const id = videoIdOf(item);
  if (!id || typeof id !== 'string') return null;
  const rawTitle = textOf(item.title) || textOf(item.name) || '';
  if (!rawTitle) return null;
  const channel =
    item.author?.name ||
    item.authors?.[0]?.name ||
    item.artists?.[0]?.name ||
    item.artist?.name ||
    '';
  const parsed = parseArtistTitle(rawTitle, channel);
  const duration =
    parseClockDuration(item.duration?.seconds) ||
    parseClockDuration(item.duration?.text) ||
    parseClockDuration(item.length_text?.text) ||
    parseClockDuration(item.duration) ||
    null;

  return {
    id: `youtube:${id}`,
    source: 'youtube',
    type,
    youtube_id: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: parsed.title || stripTitleNoise(rawTitle),
    author: parsed.author || cleanArtistName(channel, channel, rawTitle),
    raw_title: rawTitle,
    channel: channel || null,
    duration_ms: duration != null ? Math.round(duration * 1000) : null,
    thumbnail: thumbUrl(item.thumbnails || item.thumbnail),
    view_count: textOf(item.view_count) || item.views || null,
    album_name: item.album?.name || null,
  };
}

function collectMedia(node, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) {
    for (const child of node) collectMedia(child, acc);
    return acc;
  }
  // youtubei.js@18 returns MusicResponsiveListItem nodes for both videos
  // and songs; `node.type` on those is always 'MusicResponsiveListItem'
  // (the node's own class name), so it must never shadow `item_type`
  // ('video' / 'song') the way `node.type || node.item_type` used to —
  // that pattern silently matched nothing on every current search result.
  const isMedia =
    node.type === 'Video' ||
    node.type === 'Film' ||
    node.item_type === 'video' ||
    node.item_type === 'song' ||
    Boolean(node.video_id);
  if (isMedia) {
    acc.push(node);
  }
  if (node.contents) collectMedia(node.contents, acc);
  if (node.results) collectMedia(node.results, acc);
  return acc;
}

export async function searchYouTube(query, { type = 'all' } = {}) {
  log.debug('searchYouTube: start', { query, type });
  const end = log.time('searchYouTube', { query });
  const yt = await innertube();
  const videos = [];
  const music = [];

  try {
    const searchEnd = log.time('yt.music.search (video)', { query });

    const res = await yt.music.search(query, type === 'video' ? { type: 'video' } : undefined);
    // youtubei.js@18's Search object has no top-level `.results` — media
    // sits under `.contents`, an array of MusicShelf nodes that themselves
    // have `.contents`. collectMedia already recurses through both
    // `.contents` and `.results` on whatever it's handed, so passing the
    // whole object in (rather than a specific sub-property) is both
    // correct today and more resilient to the next shape shuffle.
    const rows = collectMedia(res);
    log.debug('searchYouTube: raw video search rows', { query, rowCount: rows.length });
    for (const row of rows) {
      const mapped = asItem(row, 'video');
      if (mapped) videos.push(mapped);
    }
    searchEnd({ mappedCount: videos.length });
  } catch (err) {
    log.warn('searchYouTube: yt.music.search failed, will rely on yt-dlp fallback in resolve.js', {
      query,
      message: err.message,
    });
  }

  try {
    const musicEnd = log.time('yt.music.search (song)', { query });
    const m = await yt.music.search(query, { type: 'song'});
    // Same shape change as above — no `.songs`/`.videos` sub-collections
    // on the returned object anymore, just `.contents` shelves. Individual
    // rows still carry their own `item_type` ('song' vs 'video'), which is
    // what the loop below already branches on.
    const rows = collectMedia(m);
    log.debug('searchYouTube: raw music search rows', { query, rowCount: rows.length });
    for (const row of rows) {
      const mapped = asItem(row, row.item_type === 'video' ? 'video' : 'song');
      if (mapped) music.push(mapped);
    }
    musicEnd({ mappedCount: music.length });
  } catch (err) {
    log.debug('searchYouTube: yt.music.search unavailable/failed (optional)', {
      query,
      message: err.message,
    });
  }

  const seen = new Set();
  const items = [];
  for (const it of [...music, ...videos]) {
    if (seen.has(it.youtube_id)) continue;
    seen.add(it.youtube_id);
    items.push(it);
  }
  end({ videoCount: videos.length, musicCount: music.length, dedupedCount: items.length });
  return { items, videos, music };
}

export async function getVideoDetails(youtubeId) {
  log.debug('getVideoDetails: start', { youtubeId });
  const end = log.time('getVideoDetails', { youtubeId });
  const yt = await innertube();
  const info = await yt.getBasicInfo(youtubeId);
  const full = await yt.music.getInfo(youtubeId);
  const basic = info.basic_info || {};
  const rawTitle = basic.title || '';
  const channel = basic.author || basic.channel?.name || '';
  const parsed = parseArtistTitle(rawTitle, channel);
  const musicVideoType = full.tabs?.[0]?.content?.content?.contents?.[0]?.endpoint?.payload?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig.music_video_type || null;
  end({ rawTitle, channel });
  return {
    id: `youtube:${youtubeId}`,
    source: 'youtube',
    type: 'video',
    youtube_id: youtubeId,
    url: `https://www.youtube.com/watch?v=${youtubeId}`,
    title: parsed.title,
    author: parsed.author,
    raw_title: rawTitle,
    channel,
    duration_ms: basic.duration ? basic.duration * 1000 : null,
    thumbnail: thumbUrl(basic.thumbnail) || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    description: basic.short_description || '',
    view_count: basic.view_count || null,
    is_live: Boolean(basic.is_live),
    channel_id: basic.channel_id || null,
    music_video_type: musicVideoType,
  };
}

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

export function parseYouTubeUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input).trim());
  } catch {
    log.debug('parseYouTubeUrl: not a valid URL', { input });
    return null;
  }
  if (!YT_HOSTS.has(parsed.hostname)) {
    log.debug('parseYouTubeUrl: unrecognized host', { input, hostname: parsed.hostname });
    return null;
  }
  let result = null;
  if (parsed.hostname.includes('youtu.be')) {
    const id = parsed.pathname.split('/').filter(Boolean)[0];
    result = id ? { kind: 'video', id } : null;
  } else {
    const list = parsed.searchParams.get('list');
    const v = parsed.searchParams.get('v');
    if (parsed.pathname.startsWith('/playlist') && list) result = { kind: 'playlist', id: list };
    else if (v) result = { kind: 'video', id: v, list };
    else {
      const shorts = parsed.pathname.match(/\/shorts\/([^/?]+)/);
      if (shorts) result = { kind: 'video', id: shorts[1] };
      else {
        const channel = parsed.pathname.match(/\/(channel|c|@)\/([^/?]+)/);
        if (channel) result = { kind: 'channel', id: channel[2] };
      }
    }
  }
  log.debug('parseYouTubeUrl', { input, result });
  return result;
}