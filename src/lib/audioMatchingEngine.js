/**
 * audioMatchingEngine.js — Vroomie Hybrid Matching Engine (v3 — MFCC-Consistent)
 *
 * FIXED ROOT CAUSES:
 *  1. All comparison now uses the same 42-dim extended MFCC vector (MFCC-40 + RMS + Centroid)
 *     on BOTH the live signal and the stored references.
 *  2. Threshold logic tightened: minimum cosine ≥ 0.65 for anomaly, ≥ 0.50 for probable.
 *  3. Silence/noise rejection via RMS gate: skip if live RMS < 0.008.
 *  4. 3-frame hysteresis: must see consistent hits before declaring.
 *  5. Speech/music fingerprint rejection: discard if spectral centroid indicates broadband noise.
 *  6. Structured per-cycle debug log with: input_detected, best_match, confidence, decision.
 */

import { referenceIndex } from '../services/audioDatasetService';
import { Logger } from './logger';

// ═══════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════

// Thresholds tuned for MFCC-to-MFCC comparison (same feature space on both sides)
const ANOMALY_THRESHOLD   = 0.65;  // Confirmed anomaly — strong spectral match
const PROBABLE_THRESHOLD  = 0.50;  // Potential anomaly — moderate match
const MIN_LIVE_RMS        = 0.008; // Below ~-42 dBFS — silence / breath / ambient noise

// Spectral centroid range for automotive engine sounds (Hz, normalized to [0,1] vs Nyquist)
// Engine knock/bearing: 200-2500Hz, normalized to 16kHz Nyquist → 0.025 to 0.31
// Speech: typically 1000-4000Hz → 0.125 to 0.5
// Music: full spectrum
const ENGINE_CENTROID_MAX = 0.40; // If centroid > 0.40 of Nyquist, likely speech/music → reject

const SMOOTHING_WINDOW      = 6;  // ~1.5s of 250ms chunks
const STABILITY_DURATION_MS = 4000;
const THRESHOLD_FRAMES      = 3;  // Need 3 consecutive qualifying frames

const FAST_REJECT_COSINE = 0.30; // Pre-filter: skip refs with cosine < this

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
let scoreHistory       = [];
let consecutiveHits    = 0;
let consecutiveLabel   = null;
let activeAnomaly      = null;
let activeAnomalyTime  = 0;

// ═══════════════════════════════════════════════
// MATH
// ═══════════════════════════════════════════════

function cosineSimilarity(a, b) {
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

// ═══════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════

export function resetMatchState() {
  scoreHistory       = [];
  consecutiveHits    = 0;
  consecutiveLabel   = null;
  activeAnomaly      = null;
  activeAnomalyTime  = 0;
  Logger.info('[Match] State reset.');
}

// ═══════════════════════════════════════════════
// INTERNAL: Find best match from referenceIndex
// ═══════════════════════════════════════════════

function computeSignalMatch(liveVec) {
  if (!referenceIndex || referenceIndex.length === 0) {
    return { label: null, score: 0, category: null };
  }

  // L2-normalize live vector
  const norm = Math.sqrt(liveVec.reduce((s, v) => s + v * v, 0)) || 1;
  const live = liveVec.map(v => v / norm);

  let bestScore = 0;
  let bestRef   = null;

  for (const ref of referenceIndex) {
    const refVec = ref.embedding_vector;
    if (!refVec || !Array.isArray(refVec) || refVec.length === 0) continue;

    // Skip if marked as YAMNet vectors and live vector is MFCC — dimension mismatch would give garbage
    if (ref.isYAMNet && live.length < 100) continue;

    const cos = cosineSimilarity(live, refVec);

    // Fast reject — saves CPU
    if (cos < FAST_REJECT_COSINE) continue;

    // Structured per-comparison log (throttled — only when cos passes fast reject)
    Logger.debug(`[MATCH] ${(ref.label || '').padEnd(40)} cos=${cos.toFixed(4)}`);

    if (cos > bestScore) {
      bestScore = cos;
      bestRef   = ref;
    }
  }

  return {
    label:    bestRef ? bestRef.label    : null,
    category: bestRef ? bestRef.category : null,
    severity: bestRef ? (bestRef.severity || 'medium') : 'low',
    score:    bestScore,
  };
}

// ═══════════════════════════════════════════════
// MAIN ENTRY: matchBuffer
// Called every ~250ms with Meyda feature object
// ═══════════════════════════════════════════════

export function matchBuffer(features) {
  const rms = features.rms || 0;

  // ── Gate 1: Silence / noise rejection ────────────────────────────────────
  if (rms < MIN_LIVE_RMS) {
    console.debug(`[Vroomie Detection] Gate(silence): RMS=${rms.toFixed(5)} < ${MIN_LIVE_RMS}`);
    // Still drain the score history toward silent baseline
    scoreHistory.push(0);
    if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
    consecutiveHits = 0;
    return _noAnomaly(rms, 'silence_gate');
  }

  // ── Gate 2: Non-engine spectral centroid (speech/music rejection) ─────────
  // features.spectralCentroid from Meyda is in Hz
  const centroid = features.spectralCentroid || 0;
  const centroidNorm = centroid / (features.sampleRate || 16000) * 2; // normalize to [0,1] vs Nyquist
  if (centroid > 0 && centroidNorm > ENGINE_CENTROID_MAX) {
    console.debug(`[Vroomie Detection] Gate(centroid): centroid=${centroid.toFixed(0)}Hz (norm=${centroidNorm.toFixed(3)}) — likely speech/music, skipping`);
    scoreHistory.push(0);
    if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
    consecutiveHits = 0;
    return _noAnomaly(rms, 'centroid_gate');
  }

  // ── Build live feature vector (42-dim: MFCC-40 + RMS + centroidNorm) ─────
  // This matches exactly what computeExtendedFeatures() produces for references
  let liveVec = null;

  if (features.mfcc && features.mfcc.length >= 13) {
    // Meyda returns 13-dim MFCC by default; extend with zeros to 40 dims
    const mfccs = Array.from(features.mfcc);
    while (mfccs.length < 40) mfccs.push(0);
    // Append RMS + centroidNorm as dims 41-42
    mfccs.push(rms);
    mfccs.push(centroidNorm);
    liveVec = mfccs;
  }

  if (!liveVec) {
    console.debug('[Vroomie Detection] No MFCC features available, skipping cycle');
    return _noAnomaly(rms, 'no_features');
  }

  // ── Run matching ──────────────────────────────────────────────────────────
  const match = computeSignalMatch(liveVec);

  // ── Smooth score over window ──────────────────────────────────────────────
  scoreHistory.push(match.score);
  if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
  const smoothed = scoreHistory.reduce((a, b) => a + b, 0) / scoreHistory.length;

  // ── Structured diagnostic log ─────────────────────────────────────────────
  if (match.score > 0.1 || smoothed > 0.1) {
    console.log(JSON.stringify({
      input_detected: true,
      best_match: match.label || 'none',
      confidence: parseFloat(smoothed.toFixed(4)),
      raw_score: parseFloat(match.score.toFixed(4)),
      rms: parseFloat(rms.toFixed(5)),
      centroid_hz: parseFloat(centroid.toFixed(1)),
      decision: smoothed >= ANOMALY_THRESHOLD ? 'ANOMALY' : smoothed >= PROBABLE_THRESHOLD ? 'PROBABLE' : 'NORMAL',
    }));
  }

  // ── Decision logic ────────────────────────────────────────────────────────
  const now = Date.now();

  if (smoothed >= ANOMALY_THRESHOLD) {
    // Check label stability (same label for consecutive frames)
    if (consecutiveLabel === match.label) {
      consecutiveHits++;
    } else {
      consecutiveLabel = match.label;
      consecutiveHits  = 1;
    }

    if (consecutiveHits >= THRESHOLD_FRAMES) {
      const anomalyResult = _buildAnomaly(match, smoothed, rms, 'anomaly');
      activeAnomaly     = anomalyResult;
      activeAnomalyTime = now;
      Logger.info(`❗ CONFIRMED ANOMALY: ${match.label} (smoothed=${smoothed.toFixed(3)})`);
      return anomalyResult;
    }

  } else if (smoothed >= PROBABLE_THRESHOLD) {
    consecutiveHits = Math.max(0, consecutiveHits - 1); // Don't fully reset on probable hits
    const result = _buildAnomaly(match, smoothed, rms, 'potential_anomaly');
    return result;

  } else {
    // Below both thresholds — reset streak
    consecutiveHits  = 0;
    consecutiveLabel = null;
  }

  // ── Hysteresis: sustain confirmed anomaly through brief dropouts ──────────
  if (activeAnomaly && (now - activeAnomalyTime) < STABILITY_DURATION_MS) {
    if (smoothed < PROBABLE_THRESHOLD) {
      // Gradually release
    } else {
      activeAnomalyTime = now; // renew
    }
    return { ...activeAnomaly, signalSimilarity: smoothed, isPersistentState: true };
  } else if (activeAnomaly) {
    Logger.info(`✅ Anomaly cleared: ${activeAnomaly.anomaly}`);
    activeAnomaly = null;
  }

  return _noAnomaly(rms, 'below_threshold');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _buildAnomaly(match, smoothed, rms, status) {
  const severity = match.label?.includes('critical') ? 'critical'
                 : match.label?.includes('high')     ? 'high'
                 : match.label?.includes('medium')   ? 'medium' : 'low';

  return {
    anomaly:          match.label || 'unknown_anomaly',
    status,
    confidence:       smoothed,
    signalSimilarity: smoothed,
    mlConfidence:     0,
    finalDecision:    status === 'anomaly' ? 'ANOMALY DETECTED' : 'PROBABLE ANOMALY — FURTHER ANALYSIS RECOMMENDED',
    mode:             'mfcc_cosine',
    detectedClass:    match.label,
    classifierSource: 'mfcc_cosine_extended',
    source:           match.label,
    severity,
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
    mode:             'mfcc_cosine',
    detectedClass:    null,
    classifierSource: reason,
    source:           null,
    severity:         'low',
    rms,
  };
}
