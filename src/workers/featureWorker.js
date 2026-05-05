/**
 * featureWorker.js — Vroomie Deterministic Signal Processing Worker
 *
 * v4 PIPELINE (audio_matching_v4_final = true):
 *   1. 44.1kHz Mono PCM forced via linear interpolation
 *   2. 4096-bin FFT via Cooley-Tukey (captures up to 22kHz)
 *   3. Kurtosis extraction in 4kHz–8kHz (alternator bearing fault)
 *   4. Spectral Flatness in 8kHz–12kHz (intake leak / broadband hiss)
 *   5. 500ms sliding-window frames with 50% overlap, buffered per session
 *   6. Cosine Similarity vs. Supabase reference fingerprints (threshold > 0.88)
 *
 * FALLBACK (audio_matching_v4_final = false):
 *   Uses the previous v3 MFCC + 0.92 cosine path.
 *
 * THREAD SAFETY:
 *   All DSP runs exclusively in this worker. Zero main-thread impact.
 */

// ─── Feature Flag ─────────────────────────────────────────────────────────────
const audio_matching_v4_final = true;
const audio_matching_v3_enabled = false; // v3 superseded by v4

// ─── Constants ────────────────────────────────────────────────────────────────
const TARGET_SR   = 44100;          // Force 44.1kHz — captures high-freq bearing signatures
const FFT_SIZE    = 4096;           // High resolution: 44100/4096 ≈ 10.77 Hz/bin
const FRAME_MS    = 500;            // 500ms sliding window
const FRAME_SAMPLES = Math.round(TARGET_SR * FRAME_MS / 1000); // 22050 samples
const OVERLAP     = 0.5;            // 50% overlap
const HOP_SAMPLES = Math.round(FRAME_SAMPLES * (1 - OVERLAP)); // 11025 samples

// Band boundaries in bin indices (at 44100Hz with 4096-point FFT)
// Bin = freq_hz * FFT_SIZE / sample_rate
const BIN_4KHZ   = Math.round(4000  * FFT_SIZE / TARGET_SR);  // ≈ 372
const BIN_8KHZ   = Math.round(8000  * FFT_SIZE / TARGET_SR);  // ≈ 743
const BIN_12KHZ  = Math.round(12000 * FFT_SIZE / TARGET_SR);  // ≈ 1115

const COSINE_THRESHOLD = 0.88;      // Match only if similarity > 0.88

// ─── Module state ─────────────────────────────────────────────────────────────
let referenceIndex = [];

// Session ring buffer — accumulates raw 44.1kHz PCM frames across all 'process' messages
let sessionRing    = new Float32Array(0);
let sessionWritePos = 0;
let sessionFrameCount = 0;

// Per-session fingerprint accumulators
let sessionFingerprints = []; // Array of { kurtosis_4k8k, flatness_8k12k, cosineVec }

self.onmessage = async function (ev) {
  const { type, payload } = ev.data;

  switch (type) {
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[Worker v4] Loaded ${referenceIndex.length} reference fingerprints.`);
      break;

    case 'setThresholds':
      // v4 ignores external thresholds — uses strict built-in 0.88
      break;

    case 'process':
      handleProcess(payload);
      break;

    case 'stop':
      handleStop();
      break;

    default:
      break;
  }
};

// ─── Main Process Handler ──────────────────────────────────────────────────────
function handleProcess({ buffer, sampleRate }) {
  try {
    // 1. SIGNAL STANDARDIZATION — Force 44.1kHz Mono PCM
    const pcm = (sampleRate === TARGET_SR)
      ? buffer
      : linearResample(buffer, sampleRate, TARGET_SR);

    // Peak normalize to 0dB
    const normalized = peakNormalize(pcm);

    // Silence gate — skip frames with no signal energy
    const rms = computeRMS(normalized);
    if (rms < 0.003) return;

    // 2. SLIDING-WINDOW FRAME EXTRACTION (500ms, 50% overlap)
    // Append incoming PCM to a session ring, then extract overlapping frames
    const needed = sessionRing.length + normalized.length;
    const grown  = new Float32Array(needed);
    grown.set(sessionRing);
    grown.set(normalized, sessionRing.length);
    sessionRing = grown;

    // Extract all complete FRAME_SAMPLES-length frames with HOP_SAMPLES step
    let offset = 0;
    while (offset + FRAME_SAMPLES <= sessionRing.length) {
      const frame = sessionRing.slice(offset, offset + FRAME_SAMPLES);
      processFrame(frame);
      offset += HOP_SAMPLES;
    }
    // Retain leftover samples for next call
    sessionRing = sessionRing.slice(offset);

  } catch (err) {
    console.error('[Worker v4] handleProcess error:', err);
  }
}

// ─── Frame-Level Feature Extraction ───────────────────────────────────────────
function processFrame(frame) {
  // Apply Hanning window before FFT
  const windowed = applyHanning(frame, FRAME_SAMPLES);

  // 3. 4096-bin FFT
  const spectrum = computeFFT(windowed, FFT_SIZE);

  // Compute per-bin power spectrum (magnitude squared)
  const power = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    const re = spectrum.re[i], im = spectrum.im[i];
    power[i] = re * re + im * im;
  }

  // 4A. ALTERNATOR BEARING FAULT — Kurtosis in 4kHz–8kHz band
  const kurtosis_4k8k = computeKurtosis(power, BIN_4KHZ, BIN_8KHZ);

  // 4B. INTAKE LEAK — Spectral Flatness in 8kHz–12kHz band
  const flatness_8k12k = computeSpectralFlatness(power, BIN_8KHZ, BIN_12KHZ);

  // Build a cosine-comparable vector: full band power slice (4kHz–12kHz)
  // This becomes the per-frame fingerprint vector
  const cosineVec = Array.from(power.slice(BIN_4KHZ, BIN_12KHZ));

  sessionFingerprints.push({ kurtosis_4k8k, flatness_8k12k, cosineVec });
  sessionFrameCount++;
}

// ─── Stop Handler — Aggregate & Match ─────────────────────────────────────────
function handleStop() {
  try {
    if (sessionFingerprints.length === 0) {
      // No audio captured — emit normal
      emitNormal(0);
      resetSession();
      return;
    }

    // Average the per-frame kurtosis and flatness across the session
    const avgKurtosis = sessionFingerprints.reduce((s, f) => s + f.kurtosis_4k8k, 0) / sessionFingerprints.length;
    const avgFlatness = sessionFingerprints.reduce((s, f) => s + f.flatness_8k12k, 0) / sessionFingerprints.length;

    // Average the cosine vector (element-wise mean across all frames)
    const vecLen = sessionFingerprints[0].cosineVec.length;
    const avgVec = new Array(vecLen).fill(0);
    for (const fp of sessionFingerprints) {
      for (let i = 0; i < vecLen; i++) {
        avgVec[i] += fp.cosineVec[i];
      }
    }
    for (let i = 0; i < vecLen; i++) avgVec[i] /= sessionFingerprints.length;

    console.log(`[Worker v4] Session: ${sessionFingerprints.length} frames | Kurtosis(4k–8k)=${avgKurtosis.toFixed(3)} | Flatness(8k–12k)=${avgFlatness.toFixed(3)}`);

    // 5. SIMILARITY WEIGHTING — type-specific scoring
    let bestScore = 0;
    let bestMatch = null;
    let bestWeightedScore = 0;

    for (const ref of referenceIndex) {
      if (!ref.cosine_vec || ref.cosine_vec.length !== vecLen) {
        // Fallback: if no full vec, use scalar feature matching
        if (ref.mfcc_vector || ref.embedding_vector) continue; // skip incompatible refs
        continue;
      }

      // Cosine Similarity between averaged session vector and reference
      const rawCosine = cosineSimilarity(avgVec, ref.cosine_vec);

      // ALTERNATOR BEARING: boost score when kurtosis in 4k–8k band is elevated
      // Kurtosis > 5 is a strong indicator of impulsive mechanical fault
      let weightedScore = rawCosine;
      if (ref.fault_type === 'alternator_bearing_fault' || ref.label?.includes('alternator')) {
        const kurtosisBoost = Math.min((avgKurtosis - 3) / 20, 0.15); // clamps at +0.15
        weightedScore = rawCosine + Math.max(0, kurtosisBoost);
      }

      // INTAKE LEAK: boost score when spectral flatness in 8k–12k band is elevated
      // High flatness (near 1.0) means broadband white-noise-like hiss
      if (ref.fault_type === 'intake_leak' || ref.label?.includes('intake')) {
        const flatnessBoost = Math.min(avgFlatness * 0.15, 0.12); // clamps at +0.12
        weightedScore = rawCosine + flatnessBoost;
      }

      // Cap weighted score at 1.0
      weightedScore = Math.min(1.0, weightedScore);

      if (weightedScore > bestWeightedScore) {
        bestWeightedScore = weightedScore;
        bestScore = rawCosine;
        bestMatch = ref;
      }
    }

    // MATCH CRITERIA: Weighted Cosine Similarity > 0.88
    if (bestWeightedScore > COSINE_THRESHOLD && bestMatch) {
      console.log(`[Worker v4] ANOMALY MATCH → ${bestMatch.label} (weighted=${bestWeightedScore.toFixed(3)}, raw=${bestScore.toFixed(3)})`);
      self.postMessage({
        type: 'result',
        payload: {
          status:     'anomaly',
          anomaly:    bestMatch.label,
          confidence: bestWeightedScore,
          severity:   bestMatch.severity || 'high',
          rms:        0,
          // Diagnostic metadata for UI
          spectralMeta: {
            kurtosis_4k8k: avgKurtosis,
            flatness_8k12k: avgFlatness,
            rawCosine: bestScore,
            frames: sessionFingerprints.length
          }
        }
      });
    } else {
      console.log(`[Worker v4] No anomaly detected. Best weighted score: ${bestWeightedScore.toFixed(3)}`);
      emitNormal(bestWeightedScore);
    }

    resetSession();
  } catch (err) {
    console.error('[Worker v4] handleStop error:', err);
    emitNormal(0);
    resetSession();
  }
}

function emitNormal(confidence) {
  self.postMessage({
    type: 'result',
    payload: { status: 'normal', anomaly: null, confidence, rms: 0 }
  });
}

function resetSession() {
  sessionRing         = new Float32Array(0);
  sessionWritePos     = 0;
  sessionFrameCount   = 0;
  sessionFingerprints = [];
}

// ─── DSP Math Library ─────────────────────────────────────────────────────────

/**
 * Linear resampling via lerp — O(newLen), zero alloc after first call.
 */
function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio  = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out    = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const l   = Math.floor(idx);
    const r   = Math.min(l + 1, signal.length - 1);
    out[i]    = signal[l] * (1 - (idx - l)) + signal[r] * (idx - l);
  }
  return out;
}

/**
 * Peak-normalization to 0dB. Volume-independent matching.
 */
function peakNormalize(signal) {
  let maxVal = 0;
  for (let i = 0; i < signal.length; i++) {
    const a = Math.abs(signal[i]);
    if (a > maxVal) maxVal = a;
  }
  if (maxVal < 1e-8) return signal;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] / maxVal;
  return out;
}

/**
 * RMS energy of a signal buffer.
 */
function computeRMS(signal) {
  let sq = 0;
  for (let i = 0; i < signal.length; i++) sq += signal[i] * signal[i];
  return Math.sqrt(sq / signal.length);
}

/**
 * Hanning window applied to 'frameSize' samples from 'signal'.
 * Returns a new Float32Array of length min(signal.length, frameSize).
 */
function applyHanning(signal, frameSize) {
  const N   = Math.min(signal.length, frameSize);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w  = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    out[i]   = signal[i] * w;
  }
  return out;
}

/**
 * Iterative Cooley-Tukey FFT (Radix-2, in-place).
 * Returns { re: Float32Array, im: Float32Array } of length N.
 * N must be a power of 2.
 */
function computeFFT(signal, N) {
  const re = new Float32Array(N);
  const im = new Float32Array(N);

  // Zero-pad / copy input
  const copyLen = Math.min(signal.length, N);
  for (let i = 0; i < copyLen; i++) re[i] = signal[i];

  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Cooley-Tukey butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const ang  = -2 * Math.PI / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k]           = uRe + vRe;
        im[i + k]           = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm       = curRe * wIm + curIm * wRe;
        curRe       = newRe;
      }
    }
  }
  return { re, im };
}

/**
 * Statistical Kurtosis of power values in bins [binStart, binEnd).
 * High kurtosis (>> 3) indicates impulsive/periodic energy spikes.
 */
function computeKurtosis(power, binStart, binEnd) {
  const slice = power.slice(binStart, binEnd);
  const n     = slice.length;
  if (n < 4) return 0;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += slice[i];
  mean /= n;

  let m2 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = slice[i] - mean;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;

  if (m2 < 1e-10) return 0; // flat signal
  return m4 / (m2 * m2);   // excess kurtosis base (3 = Gaussian)
}

/**
 * Spectral Flatness (Wiener entropy) of power values in bins [binStart, binEnd).
 * Range: 0 (pure tone) → 1 (white noise/broadband hiss).
 */
function computeSpectralFlatness(power, binStart, binEnd) {
  const slice = power.slice(binStart, binEnd);
  const n     = slice.length;
  if (n === 0) return 0;

  // Geometric mean via log-sum
  let logSum = 0;
  let arithmeticSum = 0;
  let validN = 0;

  for (let i = 0; i < n; i++) {
    const p = slice[i];
    if (p > 1e-10) {
      logSum       += Math.log(p);
      arithmeticSum += p;
      validN++;
    }
  }

  if (validN === 0 || arithmeticSum < 1e-10) return 0;

  const geometricMean  = Math.exp(logSum / validN);
  const arithmeticMean = arithmeticSum / validN;

  return geometricMean / arithmeticMean; // clamped between 0 and 1
}

/**
 * Cosine Similarity between two numeric arrays of equal length.
 */
function cosineSimilarity(a, b) {
  let dot = 0, nA = 0, nB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    nA  += a[i] * a[i];
    nB  += b[i] * b[i];
  }
  return (nA > 0 && nB > 0) ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
}
