/**
 * audioMatchingEngine.js — Vroomie Detection Engine (v7 — 2-Sec Temporal Pipeline)
 *
 * PIPELINE REWRITE:
 *   - Replaces single-frame (250ms) Meyda matching with sliding-window (2s) temporal embeddings.
 *   - Live vector is an 80-dim Composite Embedding (Log-Mel + MFCC + ZCR + Energy + Spectral).
 *   - Solves instantaneous noise jitter. Hysteresis (smoothing) is completely removed since the
 *     embedding organically represents a full 2-second continuous acoustic sequence.
 *
 * STRICT GATE:
 *   - Threshold is hard-locked at >= 0.80.
 *   - Anything < 0.80 strictly returns normal ("No anomalies found").
 */

import { referenceIndex } from '../services/audioDatasetService';
import { Logger } from './logger';

// ── Strict Production Thresholds ──────────────────────────────────────────────
let ANOMALY_THRESHOLD = 0.82;  // STRICT: v11.5 matches must be >= 0.82
let MIN_LIVE_RMS      = 0.005; // Quick ignore for dead silence

const FAST_REJECT_COSINE  = 0.40; // Reduced tolerance due to high-dimensional space

// ── Runtime state ─────────────────────────────────────────────────────────────
let lastReportedScore = 0;

// ── Public: settingsStore override ────────────────────────────────────────────
export function applyThresholdOverride({ anomalyThreshold, rmsGate }) {
  // STRICT OVERRIDE BLOCKED - Hard-locked at 0.80
  // if (anomalyThreshold != null) ANOMALY_THRESHOLD = anomalyThreshold;
  if (rmsGate          != null) MIN_LIVE_RMS       = rmsGate;
  console.log(`[VM] Thresholds updated: anomaly=${ANOMALY_THRESHOLD} (LOCKED) rms=${MIN_LIVE_RMS}`);
}

export function resetMatchState() {
  lastReportedScore = 0;
  Logger.info('[Match] State reset for new temporal session.');
}

// ── Cosine similarity ─────────────────────────────────────────────────────────
function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA  += a[i] * a[i];
    nB  += b[i] * b[i];
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// ── Find best match across all references ─────────────────────────────────────
function findBestMatch(live) {
  if (!referenceIndex || referenceIndex.length === 0) {
    return { score: 0, label: null, category: null, severity: 'medium' };
  }

  let bestScore = 0;
  let bestRef   = null;

  for (const ref of referenceIndex) {
    const refVec = ref.embedding_vector;
    if (!Array.isArray(refVec) || refVec.length < 140) continue; // Expecting ~145 dims (v11.3)
    
    const rawCos = cosine(live, refVec);
    if (rawCos < FAST_REJECT_COSINE) continue;

    if (rawCos > bestScore) {
      bestScore = rawCos;
      bestRef   = ref;
    }
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

  if (parts.length > 1 && SEVERITIES.has(parts[parts.length - 1])) {
    parts.pop();
  }

  parts = parts.filter((w, i) => i === 0 || w !== parts[i - 1]);

  return parts
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Main entry: Called every 500ms block ─────────────────────────────────────
export function matchBuffer(features) {
  // If we haven't hit the 500ms sliding window trigger yet, skip.
  if (!features.compositeEmbedding) {
    return { status: 'buffering', confidence: 0 };
  }

  // Calculate quick RMS from raw frame for UI and Silence Gating
  let rms = features.rms;
  if (rms === undefined && features.rawSignalFrame) {
    let sq = 0;
    const sig = features.rawSignalFrame;
    for (let i = 0; i < sig.length; ++i) sq += sig[i] * sig[i];
    rms = Math.sqrt(sq / sig.length);
  }
  
  // Backfill for AudioRecorder.jsx UI constraints
  features.rms = rms || 0;
  features.spectralCentroid = features.spectralCentroid || 0;

  // Gate 1: Silence
  if (rms < MIN_LIVE_RMS) {
    return _noAnomaly(rms, 'silence_gate');
  }

  // Execute Temporal 80-dim Match
  const match = findBestMatch(features.compositeEmbedding);
  
  // Only log in dev — console.debug is expensive in hot paths (DevTools serialisation)
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    Logger.debug(`[VM] Temporal Match: raw=${match.score.toFixed(3)} label=${match.label ?? 'none'}`);
  }

  // STRICT RULE: If < 0.82 (v11.5), ALWAYS return No anomalies found
  if (match.score >= ANOMALY_THRESHOLD && match.label) {
    lastReportedScore = match.score;
    Logger.info(`❗ TEMPORAL MATCH CONFIRMED: ${match.label} (score=${match.score.toFixed(3)})`);
    return _anomaly({ label: match.label, severity: match.severity }, match.score, rms);
  }

  return _noAnomaly(rms, 'below_strict_threshold');
}

// ── Result builders ───────────────────────────────────────────────────────────
function _anomaly(match, score, rms) {
  return {
    anomaly:          match.label,
    status:           'anomaly',
    confidence:       score,
    signalSimilarity: score,
    mlConfidence:     0,
    finalDecision:    'ANOMALY DETECTED',
    mode:             'temporal_embed_v7',
    detectedClass:    match.label,
    classifierSource: 'temporal_embed_v7',
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
    mode:             'temporal_embed_v11_5',
    detectedClass:    null,
    classifierSource: reason,
    source:           null,
    severity:         'low',
    rms,
  };
}
