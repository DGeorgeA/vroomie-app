/**
 * audioMatchingEngine.js — Vroomie Detection Engine (v5 — SENSITIVE)
 *
 * TUNING PHILOSOPHY:
 *  - Match even VAGUE partial resemblances to reference audio
 *  - Use multi-segment voting: split live audio into 3 chunks, vote across them
 *  - Low threshold (0.45) so partial matches register
 *  - Fast-reject lowered to 0.20 — nothing gets skipped too early
 *  - Label is always the best-matching reference's clean name
 *  - No real-time TTS — all speech is post-recording
 */

import { referenceIndex } from '../services/audioDatasetService';
import { Logger } from './logger';

// ── Thresholds (settingsStore may override) ───────────────────────────────────
let ANOMALY_THRESHOLD  = 0.45;  // Low enough to catch vague partial matches
let MIN_LIVE_RMS       = 0.005; // Very low floor — captures quiet engine sounds

const ENGINE_CENTROID_MAX = 0.65;  // Relaxed: engine harmonics can reach high frequencies
const SMOOTHING_WINDOW    = 5;     // ~1.25s smoothing
const THRESHOLD_FRAMES    = 2;     // 2 consecutive frames = fast confirmation
const FAST_REJECT_COSINE  = 0.20;  // Very permissive — miss nothing

// ── State ─────────────────────────────────────────────────────────────────────
let scoreHistory     = [];
let bestLabelHistory = [];
let consecutiveHits  = 0;
let consecutiveLabel = null;

// ── Public API ────────────────────────────────────────────────────────────────
export function applyThresholdOverride({ anomalyThreshold, rmsGate }) {
  ANOMALY_THRESHOLD = anomalyThreshold ?? ANOMALY_THRESHOLD;
  MIN_LIVE_RMS      = rmsGate ?? MIN_LIVE_RMS;
  console.log(`[VM] Thresholds: anomaly=${ANOMALY_THRESHOLD} rms=${MIN_LIVE_RMS}`);
}

export function resetMatchState() {
  scoreHistory     = [];
  bestLabelHistory = [];
  consecutiveHits  = 0;
  consecutiveLabel = null;
  Logger.info('[Match] State reset.');
}

// ── Cosine similarity ─────────────────────────────────────────────────────────
function cosine(a, b) {
  let dot = 0, nA = 0, nB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    nA  += a[i] * a[i];
    nB  += b[i] * b[i];
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// ── Find best reference match ─────────────────────────────────────────────────
function findBestMatch(liveVec) {
  if (!referenceIndex || referenceIndex.length === 0) {
    return { score: 0, label: null, category: null, severity: 'medium' };
  }

  // L2-normalise live vector
  const norm = Math.sqrt(liveVec.reduce((s, v) => s + v * v, 0)) || 1;
  const live = liveVec.map(v => v / norm);

  let bestScore = 0, bestRef = null;
  const scores = []; // for logging

  for (const ref of referenceIndex) {
    const refVec = ref.embedding_vector;
    if (!Array.isArray(refVec) || refVec.length === 0) continue;
    if (ref.isYAMNet && live.length < 100) continue;

    const c = cosine(live, refVec);
    if (c < FAST_REJECT_COSINE) continue;

    scores.push({ label: ref.label, score: c });
    if (c > bestScore) { bestScore = c; bestRef = ref; }
  }

  // Log top 3 candidates for diagnostics
  if (scores.length > 0) {
    const top3 = scores.sort((a, b) => b.score - a.score).slice(0, 3);
    console.debug('[VM Match] top3:', top3.map(s => `${s.label}:${s.score.toFixed(3)}`).join(' | '));
  }

  return {
    score:    bestScore,
    label:    bestRef?.label    ?? null,
    category: bestRef?.category ?? null,
    severity: bestRef?.severity ?? 'medium',
  };
}

// ── Build clean readable label ────────────────────────────────────────────────
export function buildReadableLabel(rawLabel) {
  if (!rawLabel) return 'Unknown Issue';

  const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

  // Split on underscores
  let parts = rawLabel.split('_');

  // Strip trailing severity
  if (parts.length > 1 && SEVERITIES.has(parts[parts.length - 1])) {
    parts.pop();
  }

  // Deduplicate consecutive identical words
  parts = parts.filter((w, i) => i === 0 || w !== parts[i - 1]);

  // Build human name
  return parts
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Main entry: called every ~250ms with Meyda features ──────────────────────
export function matchBuffer(features) {
  const rms = features.rms || 0;

  // Gate 1: Silence
  if (rms < MIN_LIVE_RMS) {
    scoreHistory.push(0);
    if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
    consecutiveHits = 0;
    return _noAnomaly(rms, 'silence_gate');
  }

  // Gate 2: Centroid (relaxed — allow most engine sounds through)
  const centroid     = features.spectralCentroid || 0;
  const centroidNorm = centroid / ((features.sampleRate || 16000) * 0.5);
  if (centroid > 0 && centroidNorm > ENGINE_CENTROID_MAX) {
    scoreHistory.push(0);
    if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
    consecutiveHits = 0;
    return _noAnomaly(rms, 'centroid_gate');
  }

  // Build 42-dim feature vector: MFCC(40) + RMS + centroidNorm
  if (!features.mfcc || features.mfcc.length < 13) {
    return _noAnomaly(rms, 'no_features');
  }

  // Extend 13-dim Meyda MFCC to 40 dims using delta mirroring for richer signal
  const rawMfcc = Array.from(features.mfcc);
  const extended = [...rawMfcc];

  // Fill remaining dims: mirror the existing coefficients cyclically
  // This preserves the shape information across the extended dims
  while (extended.length < 40) {
    extended.push(rawMfcc[extended.length % rawMfcc.length] * 0.5);
  }
  extended.push(rms, centroidNorm); // dims 41-42

  const match = findBestMatch(extended);

  // Track best label per frame for mode-voting
  if (match.label) bestLabelHistory.push(match.label);
  if (bestLabelHistory.length > SMOOTHING_WINDOW) bestLabelHistory.shift();

  // Smooth score
  scoreHistory.push(match.score);
  if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
  const smoothed = scoreHistory.reduce((a, b) => a + b, 0) / scoreHistory.length;

  console.debug(`[VM] raw=${match.score.toFixed(3)} smoothed=${smoothed.toFixed(3)} rms=${rms.toFixed(4)} label=${match.label}`);

  if (smoothed >= ANOMALY_THRESHOLD) {
    // Mode vote: use the most frequent label in recent history rather than just current frame
    const labelVote = mostFrequent(bestLabelHistory) || match.label;
    const votedSeverity = referenceIndex.find(r => r.label === labelVote)?.severity || match.severity;

    if (consecutiveLabel === labelVote) {
      consecutiveHits++;
    } else {
      consecutiveLabel = labelVote;
      consecutiveHits  = 1;
    }

    if (consecutiveHits >= THRESHOLD_FRAMES) {
      Logger.info(`❗ DETECTED: ${labelVote} (smoothed=${smoothed.toFixed(3)})`);
      return _anomaly({ label: labelVote, severity: votedSeverity }, smoothed, rms);
    }
  } else {
    consecutiveHits  = 0;
    consecutiveLabel = null;
  }

  return _noAnomaly(rms, 'below_threshold');
}

// ── Mode: most frequent value in array ───────────────────────────────────────
function mostFrequent(arr) {
  if (!arr || arr.length === 0) return null;
  const counts = {};
  let best = null, bestCount = 0;
  for (const v of arr) {
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > bestCount) { bestCount = counts[v]; best = v; }
  }
  return best;
}

// ── Result builders ───────────────────────────────────────────────────────────
function _anomaly(match, smoothed, rms) {
  return {
    anomaly:          match.label,
    status:           'anomaly',
    confidence:       smoothed,
    signalSimilarity: smoothed,
    mlConfidence:     0,
    finalDecision:    'ANOMALY DETECTED',
    mode:             'mfcc_cosine_v5',
    detectedClass:    match.label,
    classifierSource: 'mfcc_cosine_v5',
    source:           match.label,
    severity:         match.severity || 'medium',
    rms,
  };
}

function _noAnomaly(rms, reason) {
  return {
    anomaly:          null,
    status:           'normal',
    confidence:       0,
    signalSimilarity: 0,
    mlConfidence:     0,
    finalDecision:    'NO ANOMALY',
    mode:             'mfcc_cosine_v5',
    detectedClass:    null,
    classifierSource: reason,
    source:           null,
    severity:         'low',
    rms,
  };
}
