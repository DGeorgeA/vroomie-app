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

'use strict';

// ─── Constants ────────────────────────────────────────────
const TARGET_SR   = 16000;
const N_FFT       = 512;
const HOP         = 160;    // 10ms @ 16kHz
const N_MELS      = 64;
const N_MFCC      = 13;

let referenceIndex = [];
let ANOMALY_THRESHOLD = 0.80;
let MIN_LIVE_RMS      = 0.005;
const FAST_REJECT     = 0.50;

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

    // 6. Compute 80-dim embedding
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
// SIGNAL PROCESSING (all inline — no imports in worker)
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
  // High-pass 50Hz
  const wHP = 2 * Math.PI * 50 / sr;
  const cHP = Math.cos(wHP), sHP = Math.sin(wHP) / 1.414, a0HP = 1 + sHP;
  let s = biquad(signal,
    (1 + cHP) / 2 / a0HP, -(1 + cHP) / a0HP, (1 + cHP) / 2 / a0HP,
    -2 * cHP / a0HP, (1 - sHP) / a0HP);
  // Low-pass 5000Hz
  const wLP = 2 * Math.PI * 5000 / sr;
  const cLP = Math.cos(wLP), sLP = Math.sin(wLP) / 1.414, a0LP = 1 + sLP;
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
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-1, Math.min(1, signal[i] * gain));
  return out;
}

function computeRMS(signal) {
  let sq = 0;
  for (let i = 0; i < signal.length; i++) sq += signal[i] * signal[i];
  return Math.sqrt(sq / signal.length);
}

// ─── Cooley-Tukey Radix-2 FFT (in-place) ────────────────
// O(N log N) — replaces naive O(N²) DFT
function fftInPlace(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const wAngle = (2 * Math.PI) / len;
    const wRe = Math.cos(wAngle), wIm = Math.sin(wAngle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const tRe = curRe * re[i + j + half] - curIm * im[i + j + half];
        const tIm = curRe * im[i + j + half] + curIm * re[i + j + half];
        re[i + j + half] = re[i + j] - tRe;
        im[i + j + half] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;
        const nCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nCurRe;
      }
    }
  }
}

// Pre-computed Mel filterbank (cached per sampleRate)
let _cachedFB = null;
let _cachedFBsr = -1;

function getMelFilterbank(sr) {
  if (_cachedFB && _cachedFBsr === sr) return _cachedFB;
  const fftBins = N_FFT / 2 + 1;
  const melMin  = 0;
  const melMax  = 2595 * Math.log10(1 + (sr / 2) / 700);
  const melPts  = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    melPts[i] = melMin + i * (melMax - melMin) / (N_MELS + 1);
  }
  const hzPts   = new Float32Array(N_MELS + 2);
  const binPts  = new Int32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    hzPts[i]  = 700 * (Math.pow(10, melPts[i] / 2595) - 1);
    binPts[i] = Math.floor((N_FFT + 1) * hzPts[i] / sr);
  }
  const fb = [];
  for (let m = 0; m < N_MELS; m++) {
    const f = new Float32Array(fftBins);
    const lo = binPts[m], cen = binPts[m + 1], hi = binPts[m + 2];
    for (let k = lo; k < cen && k < fftBins; k++) {
      f[k] = (cen - lo) > 0 ? (k - lo) / (cen - lo) : 0;
    }
    for (let k = cen; k <= hi && k < fftBins; k++) {
      f[k] = (hi - cen) > 0 ? (hi - k) / (hi - cen) : 0;
    }
    fb.push(f);
  }
  _cachedFB   = fb;
  _cachedFBsr = sr;
  return fb;
}

// Pre-computed Hann window (cached per size)
const _hannCache = {};
function getHannWindow(size) {
  if (_hannCache[size]) return _hannCache[size];
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (size - 1));
  _hannCache[size] = w;
  return w;
}

// Reusable FFT buffers
const _reFFT = new Float32Array(N_FFT);
const _imFFT = new Float32Array(N_FFT);

/**
 * computeCompositeEmbedding — 80-dim vector using FFT-based mel + MFCC
 * O(F * N_FFT * log(N_FFT)) instead of the previous O(F * N_FFT²)
 */
function computeCompositeEmbedding(samples, sr) {
  const fb       = getMelFilterbank(sr);
  const hann     = getHannWindow(N_FFT);
  const fftBins  = N_FFT / 2 + 1;
  const numFrames = Math.max(1, Math.floor((samples.length - N_FFT) / HOP));

  const melAcc       = new Float64Array(N_MELS);  // accumulator
  let totalZCR = 0, totalRMS = 0, totalCentroid = 0;

  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP;

    // Fill FFT buffers
    for (let i = 0; i < N_FFT; i++) {
      _reFFT[i] = (samples[start + i] || 0) * hann[i];
      _imFFT[i] = 0;
    }

    // In-place FFT — O(N log N)
    fftInPlace(_reFFT, _imFFT);

    // Power spectrum (positive half only)
    let frameRMS = 0;
    let weightedSum = 0, powerSum = 0;
    for (let k = 0; k < fftBins; k++) {
      const mag = Math.sqrt(_reFFT[k] * _reFFT[k] + _imFFT[k] * _imFFT[k]);
      frameRMS  += _reFFT[k] * _reFFT[k] + _imFFT[k] * _imFFT[k];
      weightedSum += k * mag;
      powerSum    += mag;
      // Apply mel filterbank
      for (let m = 0; m < N_MELS; m++) {
        melAcc[m] += fb[m][k] * mag;
      }
    }
    totalRMS      += Math.sqrt(frameRMS / fftBins);
    totalCentroid += powerSum > 0 ? (weightedSum / powerSum) / fftBins : 0;

    // ZCR
    let zcr = 0;
    for (let i = 1; i < N_FFT; i++) {
      if ((samples[start + i] >= 0) !== (samples[start + i - 1] >= 0)) zcr++;
    }
    totalZCR += zcr / N_FFT;
  }

  // Average across frames
  for (let m = 0; m < N_MELS; m++) {
    melAcc[m] = Math.log(Math.max(melAcc[m] / numFrames, 1e-10));
  }
  const avgRMS      = totalRMS / numFrames;
  const avgZCR      = totalZCR / numFrames;
  const avgCentroid = totalCentroid / numFrames;

  // MFCC via DCT
  const mfcc = new Float32Array(N_MFCC);
  for (let k = 0; k < N_MFCC; k++) {
    let sum = 0;
    for (let m = 0; m < N_MELS; m++) {
      sum += melAcc[m] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
    }
    mfcc[k] = sum;
  }

  // L2 normalise each sub-vector
  function l2Norm(arr) {
    let n = 0;
    for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
    n = Math.sqrt(n) || 1;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
    return out;
  }

  const normMel  = l2Norm(melAcc);
  const normMfcc = l2Norm(mfcc);

  // Stack: 64 Mel + 13 MFCC + 3 stats = 80 dims
  const raw = new Float32Array(N_MELS + N_MFCC + 3);
  raw.set(normMel,  0);
  raw.set(normMfcc, N_MELS);
  raw[N_MELS + N_MFCC]     = avgRMS;
  raw[N_MELS + N_MFCC + 1] = avgZCR;
  raw[N_MELS + N_MFCC + 2] = avgCentroid;

  // Global L2 norm
  let gn = 0;
  for (let i = 0; i < raw.length; i++) gn += raw[i] * raw[i];
  gn = Math.sqrt(gn) || 1;
  const result = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) result[i] = raw[i] / gn;
  return result;
}

// ─── Cosine Similarity + Matching ────────────────────────
function cosine(a, b) {
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

function findBestMatch(live) {
  if (!referenceIndex || referenceIndex.length === 0) {
    return { score: 0, label: null, category: null, severity: 'medium' };
  }
  let bestScore = 0, bestRef = null;
  for (let i = 0; i < referenceIndex.length; i++) {
    const ref = referenceIndex[i];
    const vec = ref.embedding_vector;
    if (!Array.isArray(vec) || vec.length < 50) continue;
    const s = cosine(live, vec);
    if (s < FAST_REJECT) continue;
    if (s > bestScore) { bestScore = s; bestRef = ref; }
  }
  return {
    score:    bestScore,
    label:    bestRef?.label    ?? null,
    category: bestRef?.category ?? null,
    severity: bestRef?.severity ?? 'medium',
  };
}
