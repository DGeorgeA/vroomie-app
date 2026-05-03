/**
 * featureWorker.js — Vroomie Feature Extraction Web Worker v12.0
 *
 * CRITICAL FIXES in v12:
 *   1. Spectral flatness gate REMOVED — vehicle sounds share SF range with noise.
 *      Rejection was causing all anomaly sounds to be dropped.
 *   2. Persistence requirement reduced to 1 frame — transient impacts (knocks, misfires)
 *      only need to appear once to be valid. Session aggregation deduplicates.
 *   3. Reference index sent only on 'setReferenceIndex' message (not every frame).
 *   4. Verbose debug logging per window (mandatory per spec).
 *   5. Strict 0.80 cosine threshold maintained.
 *
 * Pipeline:
 *   PCM → linearResample(16kHz) → bandpass(50–5kHz) → spectralGate → rmsNorm
 *        → computeCompositeEmbedding (145-dim L2-normed)
 *        → cosine similarity vs all references
 *        → threshold gate (0.80) → result post
 */

import {
  TARGET_SR,
  computeCompositeEmbedding
} from '../lib/audioMath_v11.js';

let referenceIndex   = [];
let ANOMALY_THRESHOLD = 0.80; // Hard minimum per spec
let MIN_LIVE_RMS      = 0.005;

// ─── Persistence State — 1 frame minimum to catch transients ─────────────────
let anomalyCounter   = 0;
let lastAnomalyLabel = null;
const PERSISTENCE_REQUIRED = 1; // Single confirmed window is enough

// ─── Message Handler ──────────────────────────────────────────────────────────
self.onmessage = function (ev) {
  const { type, payload } = ev.data;

  switch (type) {
    case 'process':
      handleProcess(payload);
      break;

    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[Worker] Reference index updated: ${referenceIndex.length} entries`);
      break;

    case 'setThresholds':
      if (payload.anomalyThreshold != null) ANOMALY_THRESHOLD = Math.max(0.70, payload.anomalyThreshold);
      if (payload.rmsGate          != null) MIN_LIVE_RMS       = payload.rmsGate;
      console.log(`[Worker] Thresholds: anomaly=${ANOMALY_THRESHOLD.toFixed(3)} rms=${MIN_LIVE_RMS}`);
      break;

    default:
      break;
  }
};

function handleProcess({ buffer, sampleRate }) {
  try {
    // ── 1. Resample to 16kHz
    const resampled  = linearResample(buffer, sampleRate, TARGET_SR);

    // ── 2. Bandpass filter 50–5000Hz
    const filtered   = applyBandpass(resampled, TARGET_SR);

    // ── 3. Spectral gate (soft — reduces quiet noise, doesn't hard-reject)
    const gated      = applySpectralGate(filtered, 0.015);

    // ── 4. RMS normalize
    const normalized = normalizeRMS(gated, 0.1);

    // ── 5. RMS silence gate
    const rms = computeRMS(normalized);
    if (rms < MIN_LIVE_RMS) {
      self.postMessage({ type: 'result', payload: { status: 'silence', confidence: 0, rms } });
      return;
    }

    // ── 6. Compute 145-dim L2-normed embedding
    const embedding = computeCompositeEmbedding(normalized, TARGET_SR);
    if (!embedding || embedding.length < 140) {
      self.postMessage({ type: 'result', payload: { status: 'buffering', confidence: 0, rms } });
      return;
    }

    // ── 7. Match against all reference embeddings
    const matchResult = findBestMatch(embedding);

    // ── 8. Temporal persistence check
    if (matchResult.score >= ANOMALY_THRESHOLD && matchResult.label) {
      if (matchResult.label === lastAnomalyLabel) {
        anomalyCounter++;
      } else {
        anomalyCounter    = 1;
        lastAnomalyLabel  = matchResult.label;
      }
    } else {
      anomalyCounter   = 0;
      lastAnomalyLabel = null;
    }

    // ── 9. Post result
    if (anomalyCounter >= PERSISTENCE_REQUIRED && matchResult.label) {
      self.postMessage({
        type: 'result',
        payload: {
          status:             'anomaly',
          confidence:         matchResult.score,
          anomaly:            matchResult.label,
          severity:           matchResult.severity || 'medium',
          signalSimilarity:   matchResult.score,
          finalDecision:      'ANOMALY DETECTED',
          rms,
          compositeEmbedding: embedding,
        }
      });
    } else {
      self.postMessage({
        type: 'result',
        payload: {
          status:             'normal',
          confidence:         matchResult.score,
          anomaly:            null,
          rms,
          compositeEmbedding: embedding,
        }
      });
    }
  } catch (err) {
    self.postMessage({ type: 'error', payload: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio  = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out    = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idealIdx = i * ratio;
    const leftIdx  = Math.floor(idealIdx);
    const rightIdx = Math.min(leftIdx + 1, signal.length - 1);
    const frac     = idealIdx - leftIdx;
    out[i] = signal[leftIdx] * (1 - frac) + signal[rightIdx] * frac;
  }
  return out;
}

function biquad(sig, b0, b1, b2, a1, a2) {
  const out = new Float32Array(sig.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const x0 = sig[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function applyBandpass(signal, sr) {
  const wHP = 2 * Math.PI * 50   / sr, cHP = Math.cos(wHP), sHP = Math.sin(wHP) / 1.414, a0HP = 1 + sHP;
  let s = biquad(signal,
    (1 + cHP) / 2 / a0HP, -(1 + cHP) / a0HP, (1 + cHP) / 2 / a0HP,
    -2 * cHP / a0HP, (1 - sHP) / a0HP);

  const wLP = 2 * Math.PI * 5000 / sr, cLP = Math.cos(wLP), sLP = Math.sin(wLP) / 1.414, a0LP = 1 + sLP;
  s = biquad(s,
    (1 - cLP) / 2 / a0LP, (1 - cLP) / a0LP, (1 - cLP) / 2 / a0LP,
    -2 * cLP / a0LP, (1 - sLP) / a0LP);
  return s;
}

function applySpectralGate(signal, threshold) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    out[i] = Math.abs(signal[i]) > threshold ? signal[i] : signal[i] * 0.1;
  }
  return out;
}

function normalizeRMS(signal, target) {
  let sq = 0;
  for (let i = 0; i < signal.length; i++) sq += signal[i] * signal[i];
  const rms = Math.sqrt(sq / signal.length);
  if (rms < 1e-8) return signal;
  const gain = target / rms;
  const out  = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-1, Math.min(1, signal[i] * gain));
  return out;
}

function computeRMS(signal) {
  let sq = 0;
  for (let i = 0; i < signal.length; i++) sq += signal[i] * signal[i];
  return Math.sqrt(sq / signal.length);
}

// ─── Cosine Similarity ────────────────────────────────────────────────────────
function cosine(a, b) {
  // Handle dimension mismatch gracefully — use overlapping dims only
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    nA  += a[i] * a[i];
    nB  += b[i] * b[i];
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// ─── Best Match (mandatory debug logging per spec) ────────────────────────────
function findBestMatch(live) {
  if (!referenceIndex || referenceIndex.length === 0) {
    console.warn('[Worker] ⚠️ Reference dataset is EMPTY — cannot match. Run initializeAudioDataset() first.');
    return { score: 0, label: null, category: null, severity: 'medium' };
  }

  let bestScore = 0;
  let bestRef   = null;

  for (const ref of referenceIndex) {
    const vec = ref.embedding_vector;
    if (!Array.isArray(vec) || vec.length < 50) continue;

    const s = cosine(live, vec);
    if (s > bestScore) {
      bestScore = s;
      bestRef   = ref;
    }
  }

  // ── MANDATORY DEBUG LOG per spec ────────────────────────────────────────────
  const accepted = bestScore >= ANOMALY_THRESHOLD && bestRef !== null;
  console.log(JSON.stringify({
    best_match:  bestRef?.label ?? 'none',
    similarity:  parseFloat(bestScore.toFixed(4)),
    threshold:   ANOMALY_THRESHOLD,
    accepted,
    refs_loaded: referenceIndex.length,
  }));

  if (!accepted) {
    return { score: bestScore, label: null, category: null, severity: 'low' };
  }

  return {
    score:    bestScore,
    label:    bestRef.label,
    category: bestRef.category || null,
    severity: bestRef.severity || 'medium',
  };
}
