import { diceCoefficient, durationScore, normalizeText, stripTitleNoise } from '../lib/text.js';
import { child } from '../lib/logger.js';

const log = child('matcher');

const WEIGHTS = {
  title: 0.27,
  artist: 0.18,
  duration: 0.09,
  keywords: 0.20,
  channel: 0.20,
  views: 0.22,
  waveform: 0.15,
};

const VIDEO_BONUS = [
  /official\s*(music\s*)?video/i,
  /music\s*video/i,
  /\bomv\b/i,
  /\bmv\b/i,
];

const VIDEO_PENALTY = [
  /lyric/i,
  /audio\s*only/i,
  /sped\s*up/i,
  /nightcore/i,
  /slowed/i,
  /8d\s*audio/i,
  /cover/i,
  /karaoke/i,
  /live\s*(at|from|on)/i,
  /performance/i,
  /reaction/i,
  /hour\s*version/i,
  /official\s*audio/i,
  /provided to youtube/i,
  /topic/i,
  /visualizer/i,
  /fan\s*(made|video|edit|art)/i,
  /unofficial/i,
  /tribute/i,
  /type\s*beat/i,
  /instrumental/i,
  /\bremix\b/i,
  /\bmashup\b/i,
  /\bedit\b/i,
  /\btiktok\b/i,
];


const AUDIO_BONUS = [/official\s*audio/i, /provided to youtube/i, /topic/i, /visualizer/i];

function keywordScore(text, bonus, penalty) {
  const s = String(text || '');
  let v = 0.45;
  if (bonus.some((re) => re.test(s))) v += 0.45;
  if (penalty.some((re) => re.test(s))) v -= 0.5;
  return Math.max(0, Math.min(1, v));
}

function artistIn(text, artist) {
  const a = normalizeText(artist);
  const t = normalizeText(text);
  if (!a || !t) return 0;
  if (t.includes(a)) return 1;
  return diceCoefficient(a, t);
}

function relativeViewScores(candidates) {
  const values = candidates.map((candidate) => {
    const views = Number(candidate.view_count);
    return Number.isFinite(views) && views > 0
      ? Math.log10(views)
      : null;
  });

  const valid = values.filter((v) => v != null);

  if (!valid.length) {
    return candidates.map(() => 0.25);
  }

  const min = Math.min(...valid);
  const max = Math.max(...valid);

  // If every candidate has the same view count,
  // don't arbitrarily favour one.
  if (max === min) {
    return candidates.map(() => 1);
  }

  return values.map((value) => {
    if (value == null) return 0.25;

    const normalized = (value - min) / (max - min);

    // Lowest = 0.25, highest = 1.0
    return 0.25 + normalized * 0.75;
  });
}

/**
 * Weighted match between a desired track and a YouTube candidate.
 * `waveform` is 0–1 Pearson correlation of RMS envelopes, or null if not computed.
 */
export function scoreCandidate(
  target,
  candidate,
  waveform = null,
  relativeViews = 0.25,
) {
  const targetTitle = stripTitleNoise(target.title);
  const candTitle = stripTitleNoise(candidate.title || candidate.raw_title);
  const title = diceCoefficient(targetTitle, candTitle);

  const artistHaystack = [candidate.author, candidate.channel, candidate.raw_title, candidate.title]
    .filter(Boolean)
    .join(' ');
  const artist = Math.max(
    artistIn(artistHaystack, target.author),
    diceCoefficient(target.author, candidate.author || ''),
  );

  const expectedSec = target.duration_ms ? target.duration_ms / 1000 : null;
  const actualSec = candidate.duration_ms ? candidate.duration_ms / 1000 : candidate.duration_sec || null;
  const duration = durationScore(expectedSec, actualSec);

  const hay = `${candidate.raw_title || ''} ${candidate.title || ''} ${candidate.channel || ''}`;
  const wantVideo = target.intent === 'video';
  const keywords = keywordScore(hay, wantVideo ? VIDEO_BONUS : AUDIO_BONUS, wantVideo ? VIDEO_PENALTY : VIDEO_BONUS);

  const channel = /topic/i.test(candidate.channel || '')
    ? wantVideo
      ? 0.2
      : 0.9
    : /vevo/i.test(candidate.channel || '')
      ? wantVideo
        ? 0.95
        : 0.6
      : 0.5;

  const wave = waveform == null ? 0.5 : waveform;
  const useWave = waveform == null ? 0 : WEIGHTS.waveform;
  const restScale = 1 - useWave;
  const views = relativeViews;

  const parts = {
    title,
    artist,
    duration,
    keywords,
    channel,
    waveform: waveform,
    views,
  };

  const total =
    (WEIGHTS.title * title +
      WEIGHTS.artist * artist +
      WEIGHTS.duration * duration +
      WEIGHTS.keywords * keywords +
      WEIGHTS.views * views +
      WEIGHTS.channel * channel) *
      restScale +
    useWave * wave;

  log.debug('scoreCandidate', () => ({
    target: { title: target.title, author: target.author, intent: target.intent },
    candidate: { title: candidate.title, url: candidate.url, channel: candidate.channel },
    parts,
    total,
  }));

  return {
    total,
    parts,
    weights: { ...WEIGHTS, waveform: useWave },
  };
}

export function rankCandidates(target, candidates) {
  log.debug('rankCandidates: start', {
    target: {
      title: target.title,
      author: target.author,
    },
    candidateCount: candidates.length,
  });

  const end = log.time('rankCandidates', {
    candidateCount: candidates.length,
  });

  const viewScores = relativeViewScores(candidates);

  const ranked = candidates
    .map((c, index) => ({
      candidate: c,
      score: scoreCandidate(
        target,
        c,
        c.waveform ?? null,
        viewScores[index],
      ),
    }))
    .sort((a, b) => b.score.total - a.score.total);

  end(() => ({
    top: ranked.slice(0, 5).map((r) => ({
      title: r.candidate.title,
      url: r.candidate.url,
      views: r.candidate.view_count,
      total: Number(r.score.total.toFixed(4)),
    })),
  }));

  return ranked;
}

export { WEIGHTS };
