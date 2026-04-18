/**
 * audioMatchingEngine.js — Vroomie Detection Engine (v4 — STRICT)
 *
 * RULES:
 *  1. Confidence < 0.75  → NO ANOMALY. Period.
 *  2. No live TTS — all voice output is post-recording only.
 *  3. 4-frame hysteresis on the same label before confirming.
 *  4. Silence gate: RMS < 0.010 → reject.
 *  5. Centroid gate: > 40% Nyquist → reject (speech/music).
 */

import { referenceIndex } from '../services/audioDatasetService';
import { Logger } from './logger';

// ── Configurable thresholds (mutated by settingsStore) ───────────────────────
let ANOMALY_THRESHOLD  = 0.75;  // STRICT: only strong confirmed matches
let MIN_LIVE_RMS       = 0.010; // ~-40 dBFS floor

const ENGINE_CENTROID_MAX = 0.40;  // Rejects speech / music / broadband noise
const SMOOTHING_WINDOW    = 8;     // ~2s of 250ms frames
const THRESHOLD_FRAMES    = 4;     // Same label 4 consecutive frames = confirmed
const FAST_REJECT_COSINE  = 0.40;  // Hard pre-filter — saves CPU

// ── Runtime state ─────────────────────────────────────────────────────────────
let scoreHistory     = [];
let consecutiveHits  = 0;
let consecutiveLabel = null;

// ── Public: called by settingsStore sensitivity change ────────────────────────
export function applyThresholdOverride({ anomalyThreshold, rmsGate }) {
  ANOMALY_THRESHOLD = Math.max(anomalyThreshold, 0.75); // Never below 0.75
  MIN_LIVE_RMS      = rmsGate;
  console.log(`[Vroomie Engine] Thresholds: anomaly=${ANOMALY_THRESHOLD} rmsGate=${MIN_LIVE_RMS}`);
}

// ── Public: reset between sessions ────────────────────────────────────────────
export function resetMatchState() {
  scoreHistory     = [];
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

// ── Match live vector against all references ──────────────────────────────────
function findBestMatch(liveVec) {
  if (!referenceIndex || referenceIndex.length === 0) return { score: 0, label: null };

  const norm = Math.sqrt(liveVec.reduce((s, v) => s + v * v, 0)) || 1;
  const live = liveVec.map(v => v / norm);

  let bestScore = 0, bestRef = null;

  for (const ref of referenceIndex) {
    const refVec = ref.embedding_vector;
    if (!Array.isArray(refVec) || refVec.length === 0) continue;
    if (ref.isYAMNet && live.length < 100) continue;

    const c = cosine(live, refVec);
    if (c < FAST_REJECT_COSINE) continue;
    if (c > bestScore) { bestScore = c; bestRef = ref; }
  }

  return {
    score:    bestScore,
    label:    bestRef?.label    ?? null,
    category: bestRef?.category ?? null,
    severity: bestRef?.severity ?? 'medium',
  };
}

// ── Clean human-readable label from raw storage label ────────────────────────
export function buildReadableLabel(rawLabel) {
  if (!rawLabel) return 'Unknown';

  // Raw format: <category>_<descriptive_words>_<severity>
  // e.g. "bearing_fault_alternator_bearing_fault_critical"
  //   or "piston_knock_piston_high"
  //   or "anomaly_motorstarter"
  const KNOWN_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
  const KNOWN_CATEGORIES = new Set([
    'bearing_fault', 'engine_knocking', 'exhaust_leak', 'misfire',
    'belt_squeal', 'valve_issue', 'starter_issue', 'anomaly',
    'piston_knock', 'water_pump', 'steering_pump',
  ]);

  const parts = rawLabel.split('_');
  // Remove trailing severity word
  if (parts.length > 1 && KNOWN_SEVERITIES.has(parts[parts.length - 1])) {
    parts.pop();
  }

  // Deduplicate consecutive identical words (e.g. "piston piston" → "piston")
  const deduped = parts.filter((word, i) => i === 0 || word !== parts[i - 1]);

  // Title-case and join
  return deduped.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Main entry: called every ~250ms ──────────────────────────────────────────
export function matchBuffer(features) {
  const rms = features.rms || 0;

  // Gate 1: Silence
  if (rms < MIN_LIVE_RMS) {
    scoreHistory.push(0);
    if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
    consecutiveHits = 0;
    return _noAnomaly(rms, 'silence_gate');
  }

  // Gate 2: Speech / music centroid rejection
  const centroid     = features.spectralCentroid || 0;
  const centroidNorm = centroid / ((features.sampleRate || 16000) * 0.5);
  if (centroid > 0 && centroidNorm > ENGINE_CENTROID_MAX) {
    scoreHistory.push(0);
    if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
    consecutiveHits = 0;
    return _noAnomaly(rms, 'centroid_gate');
  }

  // Build 42-dim live vector: MFCC(40) + RMS + centroid_norm
  if (!features.mfcc || features.mfcc.length < 13) {
    return _noAnomaly(rms, 'no_features');
  }
  const mfccs = Array.from(features.mfcc);
  while (mfccs.length < 40) mfccs.push(0);
  mfccs.push(rms, centroidNorm);

  const match = findBestMatch(mfccs);

  // Smooth score
  scoreHistory.push(match.score);
  if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
  const smoothed = scoreHistory.reduce((a, b) => a + b, 0) / scoreHistory.length;

  // Diagnostic log
  console.debug(`[VM] score=${match.score.toFixed(3)} smoothed=${smoothed.toFixed(3)} rms=${rms.toFixed(4)} label=${match.label}`);

  // STRICT threshold — nothing below 0.75 becomes an anomaly
  if (smoothed >= ANOMALY_THRESHOLD) {
    if (consecutiveLabel === match.label) {
      consecutiveHits++;
    } else {
      consecutiveLabel = match.label;
      consecutiveHits  = 1;
    }

    if (consecutiveHits >= THRESHOLD_FRAMES) {
      Logger.info(`❗ CONFIRMED: ${match.label} (smoothed=${smoothed.toFixed(3)})`);
      return _anomaly(match, smoothed, rms);
    }
  } else {
    // Reset streak — below threshold = no anomaly
    consecutiveHits  = 0;
    consecutiveLabel = null;
  }

  return _noAnomaly(rms, 'below_threshold');
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
    mode:             'mfcc_cosine',
    detectedClass:    match.label,
    classifierSource: 'mfcc_cosine_v4',
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
    mode:             'mfcc_cosine',
    detectedClass:    null,
    classifierSource: reason,
    source:           null,
    severity:         'low',
    rms,
  };
}
