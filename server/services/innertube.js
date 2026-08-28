import { Innertube } from 'youtubei.js';
import { parseClockDuration, parseArtistTitle, stripTitleNoise, cleanArtistName } from '../lib/text.js';

let clientPromise = null;

export async function innertube() {
  if (!clientPromise) {
    clientPromise = Innertube.create({
      retrieve_player: false,
      generate_session_locally: true,
    }).catch((err) => {
      clientPromise = null;
      throw err;
    });
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
  const type = node.type || node.item_type;
  if (type === 'Video' || type === 'Film' || type === 'song' || type === 'video' || node.video_id) {
    acc.push(node);
  }
  if (node.contents) collectMedia(node.contents, acc);
  if (node.results) collectMedia(node.results, acc);
  return acc;
}

export async function searchYouTube(query, { type = 'all' } = {}) {
  const yt = await innertube();
  const videos = [];
  const music = [];

  try {
    const res = await yt.search(query, type === 'video' ? { type: 'video' } : undefined);
    for (const row of collectMedia(res.results)) {
      const mapped = asItem(row, 'video');
      if (mapped) videos.push(mapped);
    }
  } catch {
    // Innertube search can flake; yt-dlp ytsearch is the fallback in resolve.
  }

  try {
    const m = await yt.music.search(query);
    const rows = collectMedia(m.songs?.contents).concat(collectMedia(m.videos?.contents));
    for (const row of rows) {
      const mapped = asItem(row, row.item_type === 'video' ? 'video' : 'song');
      if (mapped) music.push(mapped);
    }
  } catch {
    // music.search is optional
  }

  const seen = new Set();
  const items = [];
  for (const it of [...music, ...videos]) {
    if (seen.has(it.youtube_id)) continue;
    seen.add(it.youtube_id);
    items.push(it);
  }
  return { items, videos, music };
}

export async function getVideoDetails(youtubeId) {
  const yt = await innertube();
  const info = await yt.getBasicInfo(youtubeId);
  const basic = info.basic_info || {};
  const rawTitle = basic.title || '';
  const channel = basic.author || basic.channel?.name || '';
  const parsed = parseArtistTitle(rawTitle, channel);
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
    return null;
  }
  if (!YT_HOSTS.has(parsed.hostname)) return null;
  if (parsed.hostname.includes('youtu.be')) {
    const id = parsed.pathname.split('/').filter(Boolean)[0];
    return id ? { kind: 'video', id } : null;
  }
  const list = parsed.searchParams.get('list');
  const v = parsed.searchParams.get('v');
  if (parsed.pathname.startsWith('/playlist') && list) return { kind: 'playlist', id: list };
  if (v) return { kind: 'video', id: v, list };
  const shorts = parsed.pathname.match(/\/shorts\/([^/?]+)/);
  if (shorts) return { kind: 'video', id: shorts[1] };
  const channel = parsed.pathname.match(/\/(channel|c|@)\/([^/?]+)/);
  if (channel) return { kind: 'channel', id: channel[2] };
  return null;
}
