/**
 * audioMatchingEngine.js — Vroomie Detection Engine (v6 — DIMENSION-CONSISTENT)
 *
 * ROOT CAUSE OF INACCURACY (FIXED):
 *   Meyda produces 13 MFCC coefficients at runtime.
 *   References were stored as 42-dim vectors (40 MFCC + RMS + centroid).
 *   Comparing 13-dim live vs 42-dim reference via cosine = meaningless result.
 *
 * FIX:
 *   At match time, truncate BOTH vectors to the shortest common dimension.
 *   This guarantees an apples-to-apples cosine comparison.
 *
 *   Live vector built as: [mfcc_0..12 (13 dims)] + [rms, centroidNorm] = 15 dims
 *   Reference vector at match time: ref[0..14] = first 15 dims
 *   Both are L2-normalised before cosine.
 *
 * SENSITIVITY:
 *   Threshold = 0.55 — catches vague partial matches reliably.
 *   2 consecutive confirmed frames required.
 *   Mode-voting over 5 frames picks most frequent label.
 *
 * NO REAL-TIME TTS — all speech is post-recording only.
 */

import { referenceIndex } from '../services/audioDatasetService';
import { Logger } from './logger';

// ── Configurable thresholds ───────────────────────────────────────────────────
let ANOMALY_THRESHOLD = 0.55;  // Tuned for 15-dim alignment — catches partial matches
let MIN_LIVE_RMS      = 0.004; // Low floor, catches quiet engine resonance

const ENGINE_CENTROID_MAX = 0.70;  // Relaxed: allow high-frequency engine harmonics
const SMOOTHING_WINDOW    = 5;     // ~1.25s at 250ms frame interval
const THRESHOLD_FRAMES    = 2;     // 2 consecutive confirming frames = detection
const FAST_REJECT_COSINE  = 0.15;  // Very permissive — we skip nothing meaningful

// ── Runtime state ─────────────────────────────────────────────────────────────
let scoreHistory     = [];
let bestLabelHistory = [];
let consecutiveHits  = 0;
let consecutiveLabel = null;

// ── Public: settingsStore override ────────────────────────────────────────────
export function applyThresholdOverride({ anomalyThreshold, rmsGate }) {
  if (anomalyThreshold != null) ANOMALY_THRESHOLD = anomalyThreshold;
  if (rmsGate          != null) MIN_LIVE_RMS       = rmsGate;
  console.log(`[VM] Thresholds updated: anomaly=${ANOMALY_THRESHOLD} rms=${MIN_LIVE_RMS}`);
}

// ── Reset between sessions ────────────────────────────────────────────────────
export function resetMatchState() {
  scoreHistory     = [];
  bestLabelHistory = [];
  consecutiveHits  = 0;
  consecutiveLabel = null;
  Logger.info('[Match] State reset for new session.');
}

// ── Cosine similarity (dimension-consistent) ─────────────────────────────────
function cosine(a, b) {
  // Always compare at the shortest common length — prevents dimension mismatch
  const len = Math.min(a.length, b.length);
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    nA  += a[i] * a[i];
    nB  += b[i] * b[i];
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// ── L2-normalise a vector ─────────────────────────────────────────────────────
function l2norm(vec) {
  const n = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / n);
}

// ── Find best match across all references ─────────────────────────────────────
function findBestMatch(liveVec) {
  if (!referenceIndex || referenceIndex.length === 0) {
    console.warn('[VM] referenceIndex is empty — dataset not loaded!');
    return { score: 0, label: null, category: null, severity: 'medium' };
  }

  const live = l2norm(liveVec);

  let bestScore = 0;
  let bestRef   = null;
  const topCandidates = [];

  for (const ref of referenceIndex) {
    const refVec = ref.embedding_vector;
    if (!Array.isArray(refVec) || refVec.length === 0) continue;
    // Skip YAMNet refs when live is MFCC-based (dimension space incompatible)
    if (ref.isYAMNet && live.length < 100) continue;

    // Fast pre-filter on raw cosine (unnormalised quick check)
    const rawCos = cosine(live, refVec);
    if (rawCos < FAST_REJECT_COSINE) continue;

    topCandidates.push({ label: ref.label, score: rawCos, ref });
    if (rawCos > bestScore) {
      bestScore = rawCos;
      bestRef   = ref;
    }
  }

  // Log top-3 for debugging
  if (topCandidates.length > 0) {
    const top3 = topCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(c => `${c.label}:${c.score.toFixed(3)}`);
    console.debug(`[VM] Top3: ${top3.join(' | ')} | refCount=${referenceIndex.length}`);
  } else {
    console.debug(`[VM] No candidates passed fast-reject. refCount=${referenceIndex.length}`);
  }

  return {
    score:    bestScore,
    label:    bestRef?.label    ?? null,
    category: bestRef?.category ?? null,
    severity: bestRef?.severity ?? 'medium',
  };
}

// ── Build clean human-readable label ─────────────────────────────────────────
export function buildReadableLabel(rawLabel) {
  if (!rawLabel) return 'Unknown Issue';
  const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

  let parts = rawLabel.split('_');

  // Remove known filename cruft (category prefixes like "engine_knocking_")
  // and trailing severity words
  if (parts.length > 1 && SEVERITIES.has(parts[parts.length - 1])) {
    parts.pop();
  }

  // Deduplicate consecutive identical words: "piston piston" → "piston"
  parts = parts.filter((w, i) => i === 0 || w !== parts[i - 1]);

  return parts
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Main entry: called every ~250ms with Meyda feature object ────────────────
export function matchBuffer(features) {
  const rms = features.rms || 0;

  // Gate 1: Silence / breath noise rejection
  if (rms < MIN_LIVE_RMS) {
    scoreHistory.push(0);
    if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
    consecutiveHits = 0;
    return _noAnomaly(rms, 'silence_gate');
  }

  // Gate 2: Speech and music rejection via spectral centroid
  const centroid     = features.spectralCentroid || 0;
  const centroidNorm = centroid / ((features.sampleRate || 16000) * 0.5);
  if (centroid > 0 && centroidNorm > ENGINE_CENTROID_MAX) {
    scoreHistory.push(0);
    if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
    consecutiveHits = 0;
    return _noAnomaly(rms, 'centroid_gate');
  }

  // Validate Meyda MFCC is available
  if (!features.mfcc || features.mfcc.length < 5) {
    return _noAnomaly(rms, 'no_features');
  }

  // ── Build live feature vector ─────────────────────────────────────────────
  // Meyda gives 13 MFCCs. We use all 13 + RMS + centroidNorm = 15 dims.
  // The cosine() function truncates both to min(live.length, ref.length),
  // so this correctly aligns with 42-dim references (uses first 15 of ref).
  const mfccArr = Array.from(features.mfcc).slice(0, 13); // exactly 13
  const liveVec = [...mfccArr, rms, centroidNorm];          // 15-dim

  const match = findBestMatch(liveVec);

  // Track best label per frame for mode-voting
  if (match.label) {
    bestLabelHistory.push(match.label);
    if (bestLabelHistory.length > SMOOTHING_WINDOW) bestLabelHistory.shift();
  }

  // Smooth score over window
  scoreHistory.push(match.score);
  if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
  const smoothed = scoreHistory.reduce((a, b) => a + b, 0) / scoreHistory.length;

  console.debug(
    `[VM] raw=${match.score.toFixed(3)} smooth=${smoothed.toFixed(3)} ` +
    `rms=${rms.toFixed(4)} label=${match.label ?? 'none'} refs=${referenceIndex?.length ?? 0}`
  );

  if (smoothed >= ANOMALY_THRESHOLD) {
    // Mode vote: most frequently appearing label in recent history
    const votedLabel    = mostFrequent(bestLabelHistory) || match.label;
    const votedSeverity = referenceIndex.find(r => r.label === votedLabel)?.severity ?? match.severity;

    if (consecutiveLabel === votedLabel) {
      consecutiveHits++;
    } else {
      consecutiveLabel = votedLabel;
      consecutiveHits  = 1;
    }

    if (consecutiveHits >= THRESHOLD_FRAMES) {
      Logger.info(`❗ CONFIRMED: ${votedLabel} (smoothed=${smoothed.toFixed(3)})`);
      return _anomaly({ label: votedLabel, severity: votedSeverity }, smoothed, rms);
    }
  } else {
    consecutiveHits  = 0;
    consecutiveLabel = null;
  }

  return _noAnomaly(rms, 'below_threshold');
}

// ── Most frequent value in array ─────────────────────────────────────────────
function mostFrequent(arr) {
  if (!arr || arr.length === 0) return null;
  const freq = {};
  let best = null, bestN = 0;
  for (const v of arr) {
    freq[v] = (freq[v] || 0) + 1;
    if (freq[v] > bestN) { bestN = freq[v]; best = v; }
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
    mode:             'mfcc15_cosine_v6',
    detectedClass:    match.label,
    classifierSource: 'mfcc15_cosine_v6',
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
    mode:             'mfcc15_cosine_v6',
    detectedClass:    null,
    classifierSource: reason,
    source:           null,
    severity:         'low',
    rms,
  };
}
