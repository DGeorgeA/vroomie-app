/**
 * AudioV5_SuperProcessor.worker.js — Symmetric DSP Engine
 *
 * CORE PRINCIPLE: Live audio and reference fingerprints go through
 * IDENTICAL DSP processing. If they don't, cosine similarity is meaningless.
 *
 * Pipeline (audio_matching_final_v5_hardened = true):
 *   1. Resample to 44.1kHz
 *   2. Peak-normalize to 0dB (volume-independent matching)
 *   3. 500ms sliding-window frames (50% overlap via HOP)
 *   4. Hanning window + 4096-bin FFT per frame
 *   5. Log-magnitude compression on each bin
 *   6. Extract 4kHz–12kHz band vector (same slice as generate_fingerprints.mjs)
 *   7. Average all frame vectors across the session
 *   8. Cosine similarity against reference vectors from Supabase
 *   9. Adaptive threshold based on environment SNR
 *
 * REMOVED (asymmetric, hurt matching):
 *   - Spectral noise subtraction (subtracts different amounts from live vs. reference)
 *
 * ADDED (help matching):
 *   - Sub-band kurtosis/flatness as PAPR boost for fault-type-specific weighting
 *   - Tail-frame zero-padding on stop to avoid dropping final data
 */

const TARGET_SR     = 44100;
const FFT_SIZE      = 4096;
const FRAME_MS      = 500;
const FRAME_SAMPLES = Math.round(TARGET_SR * FRAME_MS / 1000); // 22050
const HOP_SAMPLES   = Math.round(FRAME_SAMPLES * 0.5);         // 50% overlap

// Band bins (same as generate_fingerprints.mjs)
const BIN_4KHZ  = Math.round(4000  * FFT_SIZE / TARGET_SR);
const BIN_8KHZ  = Math.round(8000  * FFT_SIZE / TARGET_SR);
const BIN_12KHZ = Math.round(12000 * FFT_SIZE / TARGET_SR);

// Adaptive threshold — recalculated from first 200ms noise profile
let currentThreshold = 0.85;
let referenceIndex   = [];

// Session state
let sessionRing         = new Float32Array(0);
let sessionFrameVecs    = [];  // per-frame CSD vectors
let sessionPaprs        = [];  // per-frame PAPR (4k–8k)
let sessionFlatnesses   = [];  // per-frame spectral flatness (8k–12k)

// Noise profile state (200ms adaptation)
const NOISE_PROFILE_SAMPLES = Math.round(TARGET_SR * 0.2);
let noiseProfileBuf     = new Float32Array(0);
let noiseProfileReady   = false;
let noiseRmsMagnitude   = 0;  // used for adaptive threshold

// ─── Message Handler ──────────────────────────────────────────────────────────
self.onmessage = function (ev) {
  const { type, payload } = ev.data;
  switch (type) {
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[Worker v5] Loaded ${referenceIndex.length} reference fingerprints.`);
      break;
    case 'setThresholds': break; // ignored — adaptive only
    case 'process': handleProcess(payload); break;
    case 'stop':    handleStop();           break;
  }
};

// ─── Frame Processing ─────────────────────────────────────────────────────────
function handleProcess({ buffer, sampleRate }) {
  try {
    // 1. Resample to TARGET_SR
    const pcm = sampleRate === TARGET_SR ? buffer : linearResample(buffer, sampleRate, TARGET_SR);

    // 2. Peak normalize — same as reference generation
    const normalized = peakNormalize(pcm);

    // 3. Collect first 200ms as noise profile for adaptive threshold
    if (!noiseProfileReady) {
      const combined = new Float32Array(noiseProfileBuf.length + normalized.length);
      combined.set(noiseProfileBuf);
      combined.set(normalized, noiseProfileBuf.length);
      noiseProfileBuf = combined;

      if (noiseProfileBuf.length >= NOISE_PROFILE_SAMPLES) {
        // Compute RMS of noise floor
        let sq = 0;
        for (let i = 0; i < NOISE_PROFILE_SAMPLES; i++) sq += noiseProfileBuf[i] * noiseProfileBuf[i];
        noiseRmsMagnitude = Math.sqrt(sq / NOISE_PROFILE_SAMPLES);
        currentThreshold  = calculateDynamicThreshold(noiseRmsMagnitude);
        noiseProfileReady = true;
        console.log(`[Worker v5] Noise floor RMS=${noiseRmsMagnitude.toFixed(4)}, threshold=${currentThreshold.toFixed(3)}`);

        // Feed the remainder into the session ring
        const remainder   = noiseProfileBuf.slice(NOISE_PROFILE_SAMPLES);
        const newRing     = new Float32Array(sessionRing.length + remainder.length);
        newRing.set(sessionRing);
        newRing.set(remainder, sessionRing.length);
        sessionRing = newRing;
      } else {
        return; // accumulate more
      }
    } else {
      // Append to session ring
      const newRing = new Float32Array(sessionRing.length + normalized.length);
      newRing.set(sessionRing);
      newRing.set(normalized, sessionRing.length);
      sessionRing = newRing;
    }

    // 4. Extract 500ms overlapping frames
    let offset = 0;
    while (offset + FRAME_SAMPLES <= sessionRing.length) {
      processFrame(sessionRing.slice(offset, offset + FRAME_SAMPLES));
      offset += HOP_SAMPLES;
    }
    sessionRing = sessionRing.slice(offset);

  } catch (err) {
    console.error('[Worker v5] process error:', err);
  }
}

function processFrame(frame) {
  // Hanning window on FRAME_SAMPLES, zero-pad to FFT_SIZE
  const padded = new Float32Array(FFT_SIZE);
  const N      = Math.min(frame.length, FFT_SIZE);
  for (let i = 0; i < N; i++) {
    padded[i] = frame[i] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1))));
  }

  const { re, im } = computeFFT(padded, FFT_SIZE);

  // Log-magnitude compression (identical to generate_fingerprints.mjs)
  const logMag  = new Float32Array(FFT_SIZE / 2);
  const power   = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    const mag  = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
    power[i]   = mag * mag;
    logMag[i]  = Math.log10(Math.max(Number.EPSILON, mag));
  }

  // CSD vector: 4kHz–12kHz log-magnitude band
  const csdVec = Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ));

  // Sub-band metrics for type-specific weighting
  const papr     = computePAPR(power, BIN_4KHZ, BIN_8KHZ);
  const flatness = computeSpectralFlatness(power, BIN_8KHZ, BIN_12KHZ);

  sessionFrameVecs.push(csdVec);
  sessionPaprs.push(papr);
  sessionFlatnesses.push(flatness);
}

// ─── Stop Handler ─────────────────────────────────────────────────────────────
function handleStop() {
  try {
    // Process tail samples (prevents buffer underrun)
    if (sessionRing.length > 0) {
      const padded = new Float32Array(FRAME_SAMPLES);
      padded.set(sessionRing.slice(0, Math.min(sessionRing.length, FRAME_SAMPLES)));
      processFrame(padded);
    }

    if (sessionFrameVecs.length === 0) {
      emitNormal(0);
      resetSession();
      return;
    }

    // Average all frame vectors
    const vecLen = sessionFrameVecs[0].length;
    const avgVec = new Array(vecLen).fill(0);
    for (const v of sessionFrameVecs) {
      for (let i = 0; i < vecLen; i++) avgVec[i] += v[i];
    }
    for (let i = 0; i < vecLen; i++) avgVec[i] /= sessionFrameVecs.length;

    const avgPapr     = sessionPaprs.reduce((a, b) => a + b, 0) / sessionPaprs.length;
    const avgFlatness = sessionFlatnesses.reduce((a, b) => a + b, 0) / sessionFlatnesses.length;

    console.log(`[Worker v5] ${sessionFrameVecs.length} frames | PAPR=${avgPapr.toFixed(2)} | Flatness=${avgFlatness.toFixed(3)} | Threshold=${currentThreshold.toFixed(3)}`);

    // Match against all reference fingerprints
    let bestWeighted = 0;
    let bestRaw      = 0;
    let bestMatch    = null;

    for (const ref of referenceIndex) {
      if (!Array.isArray(ref.cosine_vec) || ref.cosine_vec.length !== vecLen) continue;

      const raw          = cosineSimilarity(avgVec, ref.cosine_vec);
      let   weighted     = raw;

      // Alternator bearing: boosted by PAPR (transient/impulsive score)
      if (ref.fault_type === 'alternator_bearing_fault' || (ref.label || '').includes('alternator') || (ref.label || '').includes('Bearing')) {
        const boost = Math.min(Math.max(0, (avgPapr - 5) / 30), 0.12);
        weighted    = Math.min(1.0, raw + boost);
      }

      // Intake leak: boosted by spectral flatness (broadband hiss)
      if (ref.fault_type === 'intake_leak' || (ref.label || '').includes('intake')) {
        const boost = Math.min(avgFlatness * 0.12, 0.12);
        weighted    = Math.min(1.0, raw + boost);
      }

      if (weighted > bestWeighted) {
        bestWeighted = weighted;
        bestRaw      = raw;
        bestMatch    = ref;
      }
    }

    console.log(`[Worker v5] Best match: ${bestMatch?.label || 'none'} | weighted=${bestWeighted.toFixed(3)} | raw=${bestRaw.toFixed(3)}`);

    if (bestWeighted >= currentThreshold && bestMatch) {
      self.postMessage({
        type: 'result',
        payload: {
          status:       'anomaly',
          anomaly:      bestMatch.label,
          confidence:   bestWeighted,
          severity:     bestMatch.severity || 'high',
          rms:          noiseRmsMagnitude,
          spectralMeta: { papr: avgPapr, flatness: avgFlatness, rawCosine: bestRaw, frames: sessionFrameVecs.length, threshold: currentThreshold }
        }
      });
    } else {
      emitNormal(bestWeighted);
    }

  } catch (err) {
    console.error('[Worker v5] handleStop error:', err);
    emitNormal(0);
  } finally {
    resetSession();
  }
}

function emitNormal(confidence) {
  self.postMessage({ type: 'result', payload: { status: 'normal', anomaly: null, confidence, rms: noiseRmsMagnitude } });
}

function resetSession() {
  sessionRing       = new Float32Array(0);
  sessionFrameVecs  = [];
  sessionPaprs      = [];
  sessionFlatnesses = [];
  noiseProfileBuf   = new Float32Array(0);
  noiseProfileReady = false;
  noiseRmsMagnitude = 0;
  currentThreshold  = 0.85;
}

// ─── Adaptive Threshold ───────────────────────────────────────────────────────
function calculateDynamicThreshold(noiseRms) {
  // noiseRms is 0–1 after peak normalization.
  // Quiet room (low RMS noise): lower threshold to catch micro-faults.
  // Loud environment (high RMS noise): raise threshold to avoid false positives.
  if (noiseRms < 0.02) return 0.80;       // very quiet: sensitive
  if (noiseRms > 0.15) return 0.90;       // very noisy: conservative
  const t = (noiseRms - 0.02) / 0.13;
  return 0.80 + t * (0.90 - 0.80);        // linear interpolation
}

// ─── DSP Math ─────────────────────────────────────────────────────────────────
function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio  = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out    = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, l = Math.floor(idx), r = Math.min(l+1, signal.length-1);
    out[i] = signal[l] * (1-(idx-l)) + signal[r] * (idx-l);
  }
  return out;
}

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

function computeFFT(signal, N) {
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const copyLen = Math.min(signal.length, N);
  for (let i = 0; i < copyLen; i++) re[i] = signal[i];

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
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len, wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i+k], uIm = im[i+k];
        const vRe = re[i+k+len/2]*curRe - im[i+k+len/2]*curIm;
        const vIm = re[i+k+len/2]*curIm + im[i+k+len/2]*curRe;
        re[i+k] = uRe+vRe; im[i+k] = uIm+vIm;
        re[i+k+len/2] = uRe-vRe; im[i+k+len/2] = uIm-vIm;
        const nRe = curRe*wRe - curIm*wIm;
        curIm = curRe*wIm + curIm*wRe;
        curRe = nRe;
      }
    }
  }
  return { re, im };
}

function computePAPR(power, binStart, binEnd) {
  const count = binEnd - binStart;
  if (count <= 0) return 0;
  let peak = 0, sum = 0;
  for (let i = binStart; i < binEnd; i++) {
    const p = Math.max(Number.EPSILON, power[i]);
    if (p > peak) peak = p;
    sum += p;
  }
  return peak / Math.max(Number.EPSILON, sum / count);
}

function computeSpectralFlatness(power, binStart, binEnd) {
  const count = binEnd - binStart;
  if (count <= 0) return 0;
  let logSum = 0, arithmeticSum = 0;
  for (let i = binStart; i < binEnd; i++) {
    const p = Math.max(Number.EPSILON, power[i]);
    logSum        += Math.log(p);
    arithmeticSum += p;
  }
  const arithmeticMean = Math.max(Number.EPSILON, arithmeticSum / count);
  return Math.exp(logSum / count) / arithmeticMean;
}

function cosineSimilarity(a, b) {
  let dot = 0, nA = 0, nB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]*b[i]; nA += a[i]*a[i]; nB += b[i]*b[i];
  }
  return (nA > 0 && nB > 0) ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
}
