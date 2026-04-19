/**
 * featureWorker.js — Vroomie Feature Extraction Web Worker
 *
 * Runs entirely OFF the main thread.
 * Receives PCM Float32Array from AudioWorklet via main thread relay.
 * Runs the full signal processing pipeline:
 *   1. Resample to 16kHz
 *   2. Bandpass (50Hz–5kHz)
 *   3. Spectral gate
 *   4. RMS normalise
 *   5. Compute 80-dim Composite Embedding (Log-Mel64 + MFCC13 + RMS + ZCR + Centroid)
 *   6. Cosine similarity matching against reference index
 * Posts result back to main thread.
 *
 * PERFORMANCE: All heavy math is here. Main thread only receives tiny result objects.
 */

import { 
  TARGET_SR, 
  N_FFT, 
  HOP, 
  N_MELS, 
  N_MFCC, 
  computeCompositeEmbedding 
} from '../lib/audioMath_v11.js';

let referenceIndex = [];
let ANOMALY_THRESHOLD = 0.80;
let MIN_LIVE_RMS      = 0.005;

// ─── Message Handler ──────────────────────────────────────
self.onmessage = function (ev) {
  const { type, payload } = ev.data;

  switch (type) {
    case 'process':
      handleProcess(payload);
      break;
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      break;
    case 'setThresholds':
      if (payload.anomalyThreshold != null) ANOMALY_THRESHOLD = payload.anomalyThreshold;
      if (payload.rmsGate          != null) MIN_LIVE_RMS       = payload.rmsGate;
      break;
    default:
      break;
  }
};

function handleProcess({ buffer, sampleRate }) {
  try {
    // 1. Resample to 16kHz
    const resampled = linearResample(buffer, sampleRate, TARGET_SR);

    // 2. Bandpass filter 50–5000Hz
    const filtered = applyBandpass(resampled, TARGET_SR);

    // 3. Spectral gate
    const gated = applySpectralGate(filtered, 0.015);

    // 4. RMS normalize
    const normalized = normalizeRMS(gated, 0.1);

    // 5. RMS gate — skip silence
    const rms = computeRMS(normalized);
    if (rms < MIN_LIVE_RMS) {
      self.postMessage({ type: 'result', payload: { status: 'silence', confidence: 0, rms } });
      return;
    }

    // 6. Compute 80-dim embedding (SHARED LOGIC)
    const embedding = computeCompositeEmbedding(normalized, TARGET_SR);

    if (!embedding) {
      self.postMessage({ type: 'result', payload: { status: 'buffering', confidence: 0, rms } });
      return;
    }

    // 7. Match against reference index
    const matchResult = findBestMatch(embedding);

    // 8. Build result
    if (matchResult.score >= ANOMALY_THRESHOLD && matchResult.label) {
      self.postMessage({
        type: 'result',
        payload: {
          status:           'anomaly',
          confidence:       matchResult.score,
          anomaly:          matchResult.label,
          severity:         matchResult.severity || 'medium',
          signalSimilarity: matchResult.score,
          finalDecision:    'ANOMALY DETECTED',
          rms,
          compositeEmbedding: embedding,
        }
      });
    } else {
      self.postMessage({
        type: 'result',
        payload: {
          status:           'normal',
          confidence:       matchResult.score,
          anomaly:          null,
          rms,
          compositeEmbedding: embedding,
        }
      });
    }
  } catch (err) {
    self.postMessage({ type: 'error', payload: err.message });
  }
}

// ═══════════════════════════════════════════════════════════
// SIGNAL PROCESSING (Non-embedding utils kept local or shared)
// ═══════════════════════════════════════════════════════════

function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idealIdx  = i * ratio;
    const leftIdx   = Math.floor(idealIdx);
    const rightIdx  = Math.min(leftIdx + 1, signal.length - 1);
    const frac      = idealIdx - leftIdx;
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
  const wHP = 2 * Math.PI * 50 / sr;
  const cHP = Math.cos(wHP), sHP = Math.sin(wHP) / 1.414, a0HP = 1 + sHP;
  let s = biquad(signal, (1 + cHP) / 2 / a0HP, -(1 + cHP) / a0HP, (1 + cHP) / 2 / a0HP, -2 * cHP / a0HP, (1 - sHP) / a0HP);
  const wLP = 2 * Math.PI * 5000 / sr;
  const cLP = Math.cos(wLP), sLP = Math.sin(wLP) / 1.414, a0LP = 1 + sLP;
  s = biquad(s, (1 - cLP) / 2 / a0LP, (1 - cLP) / a0LP, (1 - cLP) / 2 / a0LP, -2 * cLP / a0LP, (1 - sLP) / a0LP);
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
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-1, Math.min(1, signal[i] * gain));
  return out;
}

function computeRMS(signal) {
  let sq = 0;
  for (let i = 0; i < signal.length; i++) sq += signal[i] * signal[i];
  return Math.sqrt(sq / signal.length);
}

// ─── Cosine Similarity + Matching ────────────────────────
function cosine(a, b) {
  if (a.length !== b.length) {
    // If dimensions do not match, the vectors represent fundamentally different features
    console.warn(`[Vroomie] Dimension mismatch! Live vector: ${a.length}-dim vs DB vector: ${b.length}-dim.`);
    return 0;
  }
  const len = a.length;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    nA  += a[i] * a[i];
    nB  += b[i] * b[i];
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

function findBestMatch(live) {
  if (!referenceIndex || referenceIndex.length === 0) {
    console.warn(`[Vroomie Worker] Reference dataset is empty.`);
    return { score: 0, label: null, category: null, severity: 'medium' };
  }
  let bestScore = 0, bestRef = null;
  for (let i = 0; i < referenceIndex.length; i++) {
    const ref = referenceIndex[i];
    const vec = ref.embedding_vector;
    
    // Strict length check is handled inside cosine(), but we also skip bad vectors
    if (!Array.isArray(vec) || vec.length < 50) continue;
    
    const s = cosine(live, vec);
    
    if (s > bestScore) { 
        bestScore = s; 
        bestRef = ref; 
    }
  }

  // MANDATORY DEBUG LOGGING
  if (bestRef) {
    const isMatch = bestScore >= ANOMALY_THRESHOLD;
    console.log(`[Vroomie Worker Detection Cycle]
  ├─ Best Match Checked: ${bestRef.label}
  ├─ Detected Similarity: ${bestScore.toFixed(4)}
  ├─ Threshold Required:  ${ANOMALY_THRESHOLD.toFixed(4)}
  └─ Result: ${isMatch ? "✅ THRESHOLD MET" : "❌ REJECTED (< Threshold)"}`);
  }

  // EXPLICIT STRICT GATE (NO FALLBACKS)
  if (bestScore >= ANOMALY_THRESHOLD && bestRef) {
      return {
        score:    bestScore,
        label:    bestRef.label,
        category: bestRef.category || null,
        severity: bestRef.severity || 'medium',
      };
  }

  // If score < threshold, return strictly NO ANOMALIES
  return {
    score: bestScore, // return score for telemetry
    label: null,
    category: null,
    severity: 'low'
  };
}
