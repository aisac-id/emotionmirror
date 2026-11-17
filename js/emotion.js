// EmotionMirror — pure expression analysis over ARKit-style blendshapes.
// Input: plain object {categoryName: score 0..1}. No DOM, no ML calls here.

export const EMOTIONS = ["JOY", "SAD", "ANGER", "SURPRISE", "FEAR", "DISGUST", "NEUTRAL"];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const avg = (b, a, c) => ((b[a] || 0) + (b[c] || 0)) / 2;

// Condensed, symmetric features from the 52 blendshapes.
export function extractFeatures(b) {
  return {
    smile: avg(b, "mouthSmileLeft", "mouthSmileRight"),
    frown: avg(b, "mouthFrownLeft", "mouthFrownRight"),
    browDown: avg(b, "browDownLeft", "browDownRight"),
    browInnerUp: b.browInnerUp || 0,
    browOuterUp: avg(b, "browOuterUpLeft", "browOuterUpRight"),
    eyeWide: avg(b, "eyeWideLeft", "eyeWideRight"),
    eyeSquint: avg(b, "eyeSquintLeft", "eyeSquintRight"),
    eyeBlink: avg(b, "eyeBlinkLeft", "eyeBlinkRight"),
    jawOpen: b.jawOpen || 0,
    mouthPress: avg(b, "mouthPressLeft", "mouthPressRight"),
    noseSneer: avg(b, "noseSneerLeft", "noseSneerRight"),
    cheekSquint: avg(b, "cheekSquintLeft", "cheekSquintRight"),
    pucker: b.mouthPucker || 0,
  };
}

export const FEATURE_KEYS = Object.keys(extractFeatures({}));

// Subtract a calibrated neutral baseline, clamp at 0, apply sensitivity.
export function applyBaseline(f, base, sens = 1) {
  const out = {};
  for (const k of FEATURE_KEYS) out[k] = clamp((f[k] - (base?.[k] || 0)) * sens, 0, 1.5);
  return out;
}

// Rule-based emotion evidence scores (roughly 0..1.6). Transparent by design:
// each emotion is a weighted recipe of facial-action features.
export function scoreEmotions(f) {
  const s = {
    JOY: 1.5 * f.smile + 0.35 * f.cheekSquint + 0.15 * f.eyeSquint - 0.8 * f.frown - 0.5 * f.browDown,
    SAD: 1.3 * f.frown + 0.7 * f.browInnerUp - 1.0 * f.smile - 0.3 * f.eyeWide,
    ANGER: 1.2 * f.browDown + 0.5 * f.noseSneer + 0.45 * f.mouthPress + 0.2 * f.eyeSquint - 0.8 * f.smile - 0.4 * f.browInnerUp,
    SURPRISE: 0.95 * f.eyeWide + 0.55 * f.browOuterUp + 0.55 * f.jawOpen + 0.25 * f.browInnerUp - 0.5 * f.frown - 0.4 * f.browDown,
    FEAR: 0.8 * f.browInnerUp + 0.7 * f.eyeWide - 0.5 * f.jawOpen - 0.6 * f.smile - 0.3 * f.browOuterUp,
    DISGUST: 1.25 * f.noseSneer + 0.35 * f.browDown + 0.3 * f.mouthPress + 0.25 * f.frown - 0.7 * f.smile - 0.3 * f.eyeWide,
    NEUTRAL: 0.3,
  };
  for (const k of EMOTIONS) s[k] = Math.max(0, s[k]);
  return s;
}

// Softmax confidence over evidence scores (temperature 0.3).
export function classify(scores) {
  const T = 0.3;
  let sum = 0, top = "NEUTRAL", topV = -1;
  const probs = {};
  for (const k of EMOTIONS) {
    if (scores[k] > topV) { topV = scores[k]; top = k; }
    probs[k] = Math.exp(scores[k] / T);
    sum += probs[k];
  }
  for (const k of EMOTIONS) probs[k] /= sum;
  return { emotion: top, confidence: probs[top], probs };
}

// Dimensional affect: valence −1..1 (unpleasant..pleasant), arousal 0..1.
export function affect(f) {
  const valence = clamp(1.3 * f.smile - 1.1 * f.frown - 0.6 * f.browDown - 0.5 * f.noseSneer - 0.3 * f.browInnerUp, -1, 1);
  const arousal = clamp(0.7 * f.eyeWide + 0.6 * f.jawOpen + 0.4 * f.browInnerUp + 0.35 * f.browOuterUp + 0.25 * f.browDown, 0, 1);
  return { valence, arousal };
}

export function smileScore(f) { return clamp(f.smile * 125, 0, 100); }

export function expressiveness(f) {
  let sum = 0;
  for (const k of FEATURE_KEYS) if (k !== "eyeBlink") sum += f[k];
  return clamp(sum * 32, 0, 100);
}

// Average feature snapshots into a neutral baseline (calibration).
export function makeBaseline(samples) {
  const base = {};
  for (const k of FEATURE_KEYS) base[k] = 0;
  if (!samples.length) return base;
  for (const s of samples) for (const k of FEATURE_KEYS) base[k] += s[k] / samples.length;
  // never baseline away a real smile — cap the offsets
  for (const k of FEATURE_KEYS) base[k] = Math.min(base[k], 0.35);
  return base;
}

export const DEFAULT_BASE = makeBaseline([]);

// Session mood accumulator. Time-weighted so background throttling can't skew it.
export class MoodTracker {
  constructor() { this.reset(); }
  reset() {
    this.dwell = {}; for (const k of EMOTIONS) this.dwell[k] = 0;
    this.totalMs = 0; this.moodIndex = 50; this.transitions = 0;
    this.lastEmotion = null; this.lastT = null;
    this.streakEmotion = null; this.streakMs = 0; this.bestStreak = { emotion: null, ms: 0 };
    this.blinks = 0; this._blinkStart = null;
  }
  push(emotion, valence, eyeBlink, t) {
    if (this.lastT === null) { this.lastT = t; this.lastEmotion = emotion; this.streakEmotion = emotion; return; }
    let dt = t - this.lastT;
    this.lastT = t;
    if (dt <= 0) return;
    if (dt > 2000) dt = 2000; // cap gaps (tab was hidden)
    this.totalMs += dt;
    this.dwell[emotion] += dt;
    // exponential moving mood index, ~8s time constant
    const alpha = 1 - Math.exp(-dt / 8000);
    this.moodIndex += ((valence + 1) * 50 - this.moodIndex) * alpha;
    if (emotion !== this.lastEmotion) {
      this.transitions++;
      this.lastEmotion = emotion;
      this.streakEmotion = emotion; this.streakMs = 0;
    } else {
      this.streakMs += dt;
      if (this.streakMs > this.bestStreak.ms) this.bestStreak = { emotion, ms: this.streakMs };
    }
    // blink counting: closed 60–500ms
    if (eyeBlink > 0.55) { if (this._blinkStart === null) this._blinkStart = t; }
    else if (this._blinkStart !== null) {
      const d = t - this._blinkStart;
      if (d >= 60 && d <= 500) this.blinks++;
      this._blinkStart = null;
    }
  }
  dominant() {
    let top = "NEUTRAL", v = -1;
    for (const k of EMOTIONS) if (this.dwell[k] > v) { v = this.dwell[k]; top = k; }
    return this.totalMs > 0 ? top : "NEUTRAL";
  }
  dwellPct() {
    const out = {};
    for (const k of EMOTIONS) out[k] = this.totalMs > 0 ? (this.dwell[k] / this.totalMs) * 100 : 0;
    return out;
  }
}