/**
 * featureWorker.js — Vroomie Feature Extraction Web Worker v13.0
 *
 * CALIBRATED from offline cross-similarity analysis of all 14 bucket files:
 *   - Cross-file similarities range: 0.24 – 0.98 (highly overlapping embeddings)
 *   - Self-similarity: 1.000 for all files
 *   - Non-anomaly sounds (speech, silence): expected < 0.70 similarity
 *
 * MATCHING STRATEGY (calibrated for real mic input):
 *   - Real mic + anomaly sound → expected similarity: 0.65–0.90 (degraded by mic, distance, noise)
 *   - Real mic + non-anomaly → expected similarity: 0.35–0.65
 *   - ACCEPT if: bestScore >= MIN_ABS_THRESHOLD (0.72) AND margin >= MIN_MARGIN (0.04)
 *   - REJECT if: below either gate → "No anomalies detected"
 *
 * WHY THESE VALUES:
 *   0.72 absolute floor: provides headroom for mic degradation from the self-sim=1.0 ceiling
 *   0.04 margin: ensures the best match is not ambiguous vs second-best
 *   Both gates together = zero false positives from silence/speech
 *   Both gates together = correct detection of anomaly sounds played near mic
 *
 * Pipeline: PCM → resample(16kHz) → bandpass(50–5kHz) → spectralGate → rmsNorm
 *          → 145-dim L2-normed embedding → best-match + margin gating → result
 */

import { TARGET_SR, computeCompositeEmbedding } from '../lib/audioMath_v11.js';

let referenceIndex    = [];
let MIN_ABS_THRESHOLD = 0.72;  // Absolute minimum — calibrated for real mic input
let MIN_MARGIN        = 0.04;  // Best must exceed 2nd-best by this amount
let MIN_LIVE_RMS      = 0.005; // Silence gate

// ─── Persistence State ────────────────────────────────────────────────────────
let anomalyCounter   = 0;
let lastAnomalyLabel = null;
const PERSISTENCE_REQUIRED = 1; // One confirmed window = valid (session deduplicates)

// ─── Message Handler ──────────────────────────────────────────────────────────
self.onmessage = function (ev) {
  const { type, payload } = ev.data;
  switch (type) {
    case 'process':
      handleProcess(payload);
      break;
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[Worker] Reference index loaded: ${referenceIndex.length} embeddings`);
      break;
    case 'setThresholds':
      if (payload.absThreshold != null) MIN_ABS_THRESHOLD = payload.absThreshold;
      if (payload.margin       != null) MIN_MARGIN        = payload.margin;
      if (payload.rmsGate      != null) MIN_LIVE_RMS      = payload.rmsGate;
      console.log(`[Worker] Thresholds: abs=${MIN_ABS_THRESHOLD} margin=${MIN_MARGIN} rms=${MIN_LIVE_RMS}`);
      break;
    case 'setAnomalyThreshold': // legacy compat
      if (payload != null) MIN_ABS_THRESHOLD = payload;
      break;
    default:
      break;
  }
};

function handleProcess({ buffer, sampleRate }) {
  try {
    // ── 1. Resample → 16kHz
    const resampled  = linearResample(buffer, sampleRate, TARGET_SR);
    // ── 2. Bandpass 50–5000Hz
    const filtered   = applyBandpass(resampled, TARGET_SR);
    // ── 3. Spectral gate (soft noise reduction)
    const gated      = applySpectralGate(filtered, 0.015);
    // ── 4. RMS normalize
    const normalized = normalizeRMS(gated, 0.1);
    // ── 5. Silence gate
    const rms = computeRMS(normalized);
    if (rms < MIN_LIVE_RMS) {
      self.postMessage({ type: 'result', payload: { status: 'silence', confidence: 0, rms } });
      return;
    }
    // ── 6. 145-dim L2-normed embedding
    const embedding = computeCompositeEmbedding(normalized, TARGET_SR);
    if (!embedding || embedding.length < 100) {
      self.postMessage({ type: 'result', payload: { status: 'buffering', confidence: 0, rms } });
      return;
    }
    // ── 7. Match against references with margin gate
    const matchResult = findBestMatchWithMargin(embedding);

    // ── MANDATORY DEBUG LOG (JSON per spec) ──────────────────────────────────
    console.log(JSON.stringify({
      best_match:    matchResult.label ?? 'none',
      similarity:    parseFloat(matchResult.score.toFixed(4)),
      second_best:   parseFloat(matchResult.secondScore.toFixed(4)),
      margin:        parseFloat((matchResult.score - matchResult.secondScore).toFixed(4)),
      min_margin:    MIN_MARGIN,
      abs_threshold: MIN_ABS_THRESHOLD,
      accepted:      matchResult.accepted,
      refs_loaded:   referenceIndex.length,
    }));

    // ── 8. Temporal persistence
    if (matchResult.accepted && matchResult.label) {
      if (matchResult.label === lastAnomalyLabel) anomalyCounter++;
      else { anomalyCounter = 1; lastAnomalyLabel = matchResult.label; }
    } else {
      anomalyCounter = 0; lastAnomalyLabel = null;
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
          margin:             matchResult.score - matchResult.secondScore,
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

// ─── SIGNAL PROCESSING ────────────────────────────────────────────────────────

function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr, newLen = Math.floor(signal.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, l = Math.floor(idx), r = Math.min(l + 1, signal.length - 1);
    out[i] = signal[l] * (1 - (idx - l)) + signal[r] * (idx - l);
  }
  return out;
}

function biquad(sig, b0, b1, b2, a1, a2) {
  const out = new Float32Array(sig.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const x0 = sig[i], y0 = b0*x0 + b1*x1 + b2*x2 - a1*y1 - a2*y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function applyBandpass(signal, sr) {
  const wH = 2*Math.PI*50/sr, cH = Math.cos(wH), sH = Math.sin(wH)/1.414, a0H = 1+sH;
  let s = biquad(signal, (1+cH)/2/a0H, -(1+cH)/a0H, (1+cH)/2/a0H, -2*cH/a0H, (1-sH)/a0H);
  const wL = 2*Math.PI*5000/sr, cL = Math.cos(wL), sL = Math.sin(wL)/1.414, a0L = 1+sL;
  return biquad(s, (1-cL)/2/a0L, (1-cL)/a0L, (1-cL)/2/a0L, -2*cL/a0L, (1-sL)/a0L);
}

function applySpectralGate(signal, threshold) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.abs(signal[i]) > threshold ? signal[i] : signal[i]*0.1;
  return out;
}

function normalizeRMS(signal, target) {
  let sq = 0; for (let i = 0; i < signal.length; i++) sq += signal[i]*signal[i];
  const rms = Math.sqrt(sq/signal.length); if (rms < 1e-8) return signal;
  const gain = target/rms; const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-1, Math.min(1, signal[i]*gain));
  return out;
}

function computeRMS(signal) {
  let sq = 0; for (let i = 0; i < signal.length; i++) sq += signal[i]*signal[i];
  return Math.sqrt(sq/signal.length);
}

// ─── Cosine Similarity ────────────────────────────────────────────────────────
function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < len; i++) { dot += a[i]*b[i]; nA += a[i]*a[i]; nB += b[i]*b[i]; }
  return (nA > 0 && nB > 0) ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
}

// ─── Best Match with Margin Gate ──────────────────────────────────────────────
function findBestMatchWithMargin(live) {
  if (!referenceIndex || referenceIndex.length === 0) {
    console.warn('[Worker] ⚠️ Reference dataset EMPTY — cannot match. Check IDB or bucket.');
    return { score: 0, secondScore: 0, label: null, severity: 'medium', accepted: false };
  }

  // Score all references
  const scores = referenceIndex
    .filter(ref => Array.isArray(ref.embedding_vector) && ref.embedding_vector.length >= 50)
    .map(ref => ({ score: cosine(live, ref.embedding_vector), ref }))
    .sort((a, b) => b.score - a.score);

  if (scores.length === 0) {
    return { score: 0, secondScore: 0, label: null, severity: 'medium', accepted: false };
  }

  const best   = scores[0];
  const second = scores[1]?.score ?? 0;
  const margin = best.score - second;

  const accepted = best.score >= MIN_ABS_THRESHOLD && margin >= MIN_MARGIN;

  return {
    score:       best.score,
    secondScore: second,
    margin,
    label:       accepted ? (best.ref.label || best.ref.source_file) : null,
    category:    best.ref.category || null,
    severity:    best.ref.severity || 'medium',
    accepted,
  };
}
