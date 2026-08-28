import { diceCoefficient, durationScore, normalizeText, stripTitleNoise } from '../lib/text.js';

const WEIGHTS = {
  title: 0.3,
  artist: 0.18,
  duration: 0.22,
  keywords: 0.1,
  channel: 0.05,
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

/**
 * Weighted match between a desired track and a YouTube candidate.
 * `waveform` is 0–1 Pearson correlation of RMS envelopes, or null if not computed.
 */
export function scoreCandidate(target, candidate, waveform = null) {
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

  const parts = {
    title,
    artist,
    duration,
    keywords,
    channel,
    waveform: waveform,
  };

  const total =
    (WEIGHTS.title * title +
      WEIGHTS.artist * artist +
      WEIGHTS.duration * duration +
      WEIGHTS.keywords * keywords +
      WEIGHTS.channel * channel) *
      restScale +
    useWave * wave;

  return {
    total,
    parts,
    weights: { ...WEIGHTS, waveform: useWave },
  };
}

export function rankCandidates(target, candidates) {
  return candidates
    .map((c) => ({ candidate: c, score: scoreCandidate(target, c, c.waveform ?? null) }))
    .sort((a, b) => b.score.total - a.score.total);
}

export { WEIGHTS };
