const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

let cached = { token: null, expiresAt: 0 };

export function spotifyConfigured() {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

export function parseSpotifyUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const url = raw.replace(/^spotify:/, 'https://open.spotify.com/');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/spotify\.com$/i.test(parsed.hostname) && parsed.hostname !== 'open.spotify.com') {
    if (!parsed.hostname.includes('spotify.com')) return null;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  // /track/id, /intl-en/album/id, /playlist/id, /artist/id
  const typeIdx = parts.findIndex((p) => ['track', 'album', 'playlist', 'artist'].includes(p));
  if (typeIdx === -1 || !parts[typeIdx + 1]) return null;
  const id = parts[typeIdx + 1].split('?')[0];
  return { type: parts[typeIdx], id };
}

async function token() {
  if (!spotifyConfigured()) {
    throw new Error('Spotify client credentials are not configured. Copy .env.example to .env.');
  }
  if (cached.token && Date.now() < cached.expiresAt - 15_000) return cached.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
  ).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Spotify token failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cached.token;
}

async function api(pathname, params) {
  const url = new URL(API + pathname);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!res.ok) {
    throw new Error(`Spotify ${pathname} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export function pickImage(images, min = 0) {
  if (!Array.isArray(images) || !images.length) return null;
  const sorted = [...images].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted.find((i) => (i.width || 0) >= min) || sorted[0];
}

export function mapTrack(track, albumOverride) {
  if (!track) return null;
  const album = albumOverride || track.album || {};
  const artists = track.artists || [];
  const author = artists.map((a) => a.name).filter(Boolean).join(', ') || 'Unknown Artist';
  const cover = pickImage(album.images);
  return {
    id: `spotify:track:${track.id}`,
    source: 'spotify',
    type: 'track',
    spotify_id: track.id,
    url: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`,
    title: track.name,
    author,
    duration_ms: track.duration_ms,
    thumbnail: cover?.url || null,
    isrc: track.external_ids?.isrc || null,
    explicit: Boolean(track.explicit),
    track_number: track.track_number,
    disc_number: track.disc_number,
    album: album.name
      ? {
          id: album.id,
          name: album.name,
          url: album.external_urls?.spotify || null,
          release_date: album.release_date,
          release_date_precision: album.release_date_precision,
          total_tracks: album.total_tracks,
          album_type: album.album_type,
          images: album.images || [],
          label: album.label || null,
        }
      : null,
    artists: artists.map((a) => ({
      id: a.id,
      name: a.name,
      url: a.external_urls?.spotify || null,
    })),
  };
}

export async function getTrack(id) {
  return api(`/tracks/${id}`);
}

export async function getAlbum(id) {
  return api(`/albums/${id}`);
}

export async function getArtist(id) {
  return api(`/artists/${id}`);
}

export async function getArtistTopTracks(id, market = 'US') {
  return api(`/artists/${id}/top-tracks`, { market });
}

export async function getPlaylist(id) {
  return api(`/playlists/${id}`);
}

export async function getPlaylistTracks(id) {
  const items = [];
  let path = `/playlists/${id}/tracks`;
  let params = { limit: 100 };
  while (path) {
    const page = await api(path.startsWith('http') ? new URL(path).pathname + new URL(path).search : path, params);
    items.push(...(page.items || []));
    if (!page.next) break;
    const next = new URL(page.next);
    path = next.pathname.replace('/v1', '');
    params = Object.fromEntries(next.searchParams);
  }
  return items;
}

export async function searchCatalog(query, types = ['track', 'album', 'artist', 'playlist'], limit = 10) {
  const json = await api('/search', {
    q: query,
    type: types.join(','),
    limit: String(limit),
  });
  return json;
}

export async function resolveSpotifyRef(ref) {
  if (ref.type === 'track') {
    const track = await getTrack(ref.id);
    return { kind: 'tracks', title: track.name, items: [mapTrack(track)].filter(Boolean) };
  }
  if (ref.type === 'album') {
    const album = await getAlbum(ref.id);
    const items = (album.tracks?.items || []).map((t) => mapTrack(t, album)).filter(Boolean);
    return {
      kind: 'album',
      title: album.name,
      collection: {
        id: album.id,
        name: album.name,
        artists: album.artists,
        images: album.images,
        release_date: album.release_date,
        label: album.label,
        genres: album.genres,
        copyrights: album.copyrights,
        external_urls: album.external_urls,
        total_tracks: album.total_tracks,
      },
      items,
    };
  }
  if (ref.type === 'playlist') {
    const playlist = await getPlaylist(ref.id);
    const tracks = await getPlaylistTracks(ref.id);
    const items = tracks.map((row) => mapTrack(row.track)).filter(Boolean);
    return {
      kind: 'playlist',
      title: playlist.name,
      collection: {
        id: playlist.id,
        name: playlist.name,
        description: playlist.description,
        owner: playlist.owner?.display_name,
        images: playlist.images,
        external_urls: playlist.external_urls,
      },
      items,
    };
  }
  if (ref.type === 'artist') {
    const artist = await getArtist(ref.id);
    const top = await getArtistTopTracks(ref.id);
    return {
      kind: 'artist',
      title: artist.name,
      collection: {
        id: artist.id,
        name: artist.name,
        genres: artist.genres,
        images: artist.images,
        followers: artist.followers?.total,
        popularity: artist.popularity,
        external_urls: artist.external_urls,
      },
      items: (top.tracks || []).map((t) => mapTrack(t)).filter(Boolean),
    };
  }
  throw new Error(`Unsupported Spotify type: ${ref.type}`);
}

export async function searchSpotify(query) {
  if (!spotifyConfigured()) return { tracks: [], albums: [], artists: [], playlists: [] };
  const json = await searchCatalog(query);
  return {
    tracks: (json.tracks?.items || []).map((t) => mapTrack(t)).filter(Boolean),
    albums: (json.albums?.items || []).map((a) => ({
      id: `spotify:album:${a.id}`,
      source: 'spotify',
      type: 'album',
      spotify_id: a.id,
      url: a.external_urls?.spotify,
      title: a.name,
      author: (a.artists || []).map((x) => x.name).join(', '),
      thumbnail: pickImage(a.images)?.url || null,
      total_tracks: a.total_tracks,
      release_date: a.release_date,
    })),
    artists: (json.artists?.items || []).map((a) => ({
      id: `spotify:artist:${a.id}`,
      source: 'spotify',
      type: 'artist',
      spotify_id: a.id,
      url: a.external_urls?.spotify,
      title: a.name,
      author: a.name,
      thumbnail: pickImage(a.images)?.url || null,
      genres: a.genres,
    })),
    playlists: (json.playlists?.items || []).filter(Boolean).map((p) => ({
      id: `spotify:playlist:${p.id}`,
      source: 'spotify',
      type: 'playlist',
      spotify_id: p.id,
      url: p.external_urls?.spotify,
      title: p.name,
      author: p.owner?.display_name,
      thumbnail: pickImage(p.images)?.url || null,
    })),
  };
}

export async function enrichAlbumAndArtist(trackLike) {
  const albumId = trackLike.album?.id;
  const artistId = trackLike.artists?.[0]?.id;
  const [album, artist] = await Promise.all([
    albumId ? getAlbum(albumId).catch(() => null) : Promise.resolve(null),
    artistId ? getArtist(artistId).catch(() => null) : Promise.resolve(null),
  ]);
  return { album, artist };
}
