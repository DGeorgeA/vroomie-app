/**
 * MechanicalAudioProcessor.worker.js — Multi-Feature Mechanical Fault Engine
 *
 * KEY FIX: FRAME_SAMPLES = FFT_SIZE = 4096 (93ms). Previously, 500ms frames
 * were used but only the first 4096 samples (18%) fed the FFT — the rest was
 * silently discarded. Now frames ARE the FFT window: every sample counts.
 *
 * MULTI-FEATURE PIPELINE:
 *   1. Resample → 44.1kHz, Peak-Normalize
 *   2. 100ms Noise Profile → Spectral Subtraction (α=1.5)
 *   3. Per frame (4096 samples, 50% overlap):
 *      a. Log-Magnitude CSD vector (4–12kHz) for cosine similarity
 *      b. Spectral Kurtosis (3–8kHz) — isolates bearing harmonics
 *      c. Spectral Flatness / Wiener entropy (8–12kHz) — detects hiss/leaks
 *   4. Short-Time Energy derivative → Transient Score (fixes Motor Starter vs Water Pump)
 *   5. Adaptive SNR threshold (0.55 quiet → 0.65 noisy)
 *   6. Fault-Type Weighting Matrix: each fault gets its own cosine/kurtosis/flatness/transient weights
 */

const TARGET_SR     = 44100;
const FFT_SIZE      = 4096;           // Frame = FFT window = 93ms @ 44.1kHz
const FRAME_SAMPLES = FFT_SIZE;       // Symmetric with generate_fingerprints.mjs
const HOP_SAMPLES   = FFT_SIZE >> 1;  // 50% overlap = 2048 samples

// Band bins
const BIN_3KHZ  = Math.round(3000  * FFT_SIZE / TARGET_SR); // 278
const BIN_4KHZ  = Math.round(4000  * FFT_SIZE / TARGET_SR); // 372
const BIN_8KHZ  = Math.round(8000  * FFT_SIZE / TARGET_SR); // 743
const BIN_12KHZ = Math.round(12000 * FFT_SIZE / TARGET_SR); // 1115

// Spectral subtraction params
const SS_ALPHA = 1.5;   // Over-subtraction factor
const SS_BETA  = 0.01;  // Spectral floor

// Noise adaptation window: first 100ms
const NOISE_SAMPLES = Math.round(TARGET_SR * 0.1); // 4410

/**
 * FAULT WEIGHTING MATRIX
 * Each fault_type maps to feature weights (must sum to 1.0).
 * This encodes domain knowledge about what each fault sounds like.
 */
const FAULT_WEIGHTS = {
  // High-Q periodic whine at bearing harmonics → heavy kurtosis weight
  'alternator_bearing_fault': { cosine: 0.25, kurtosis: 0.60, flatness: 0.05, transient: 0.10 },
  // Broadband pneumatic hiss → heavy flatness weight
  'intake_leak':              { cosine: 0.25, kurtosis: 0.05, flatness: 0.65, transient: 0.05 },
  // Sharp single-onset transient (click + motor spin) → heavy transient weight
  'motor_starter':            { cosine: 0.15, kurtosis: 0.05, flatness: 0.05, transient: 0.75 },
  // Periodic low-frequency amplitude modulation, sustained → cosine + kurtosis
  'water_pump':               { cosine: 0.45, kurtosis: 0.25, flatness: 0.15, transient: 0.15 },
  // Impulsive misfire transients → kurtosis + transient
  'misfire':                  { cosine: 0.35, kurtosis: 0.35, flatness: 0.10, transient: 0.20 },
  'engine_knock':             { cosine: 0.35, kurtosis: 0.35, flatness: 0.10, transient: 0.20 },
  'timing_chain':             { cosine: 0.45, kurtosis: 0.30, flatness: 0.10, transient: 0.15 },
  'exhaust_resonance':        { cosine: 0.55, kurtosis: 0.15, flatness: 0.20, transient: 0.10 },
  'serpentine_belt':          { cosine: 0.40, kurtosis: 0.30, flatness: 0.20, transient: 0.10 },
  'rocker_arm':               { cosine: 0.40, kurtosis: 0.35, flatness: 0.10, transient: 0.15 },
  'piston_fault':             { cosine: 0.40, kurtosis: 0.25, flatness: 0.10, transient: 0.25 },
  'power_steering':           { cosine: 0.45, kurtosis: 0.20, flatness: 0.25, transient: 0.10 },
  'pulley_misalignment':      { cosine: 0.45, kurtosis: 0.30, flatness: 0.15, transient: 0.10 },
  'motor_starter_fault':      { cosine: 0.15, kurtosis: 0.05, flatness: 0.05, transient: 0.75 },
  'default':                  { cosine: 0.55, kurtosis: 0.20, flatness: 0.15, transient: 0.10 },
};

// ─── State ────────────────────────────────────────────────────────────────────
let referenceIndex = [];

// Session accumulation
let sessionRing      = new Float32Array(0);  // incoming PCM ring
let allSessionSamples = [];                  // ALL samples for STE transient calc
let frameVecs        = [];   // CSD log-mag vectors per frame
let frameKurtoses    = [];   // spectral kurtosis per frame (3–8kHz)
let frameFlatnesses  = [];   // spectral flatness per frame (8–12kHz)

// Noise profile
let noiseBuf      = new Float32Array(0);
let noiseReady    = false;
let noiseMagProfile = new Float32Array(FFT_SIZE / 2);  // avg magnitude of noise
let noiseRms      = 0;
let currentThreshold = 0.58;

// ─── Message Handler ─────────────────────────────────────────────────────────
self.onmessage = function (ev) {
  const { type, payload } = ev.data;
  switch (type) {
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[MAP] Loaded ${referenceIndex.length} mechanical fault signatures.`);
      break;
    case 'setThresholds': break; // ignored — adaptive SNR controls threshold
    case 'process': handleProcess(payload); break;
    case 'stop':    handleStop();           break;
  }
};

// ─── Incoming Audio Processing ────────────────────────────────────────────────
function handleProcess({ buffer, sampleRate }) {
  try {
    const pcm        = sampleRate === TARGET_SR ? buffer : linearResample(buffer, sampleRate, TARGET_SR);
    const normalized = peakNormalize(pcm);

    // Accumulate all raw samples for STE transient analysis at stop
    for (let i = 0; i < normalized.length; i++) allSessionSamples.push(normalized[i]);

    // Phase 1: Collect first 100ms as noise profile
    if (!noiseReady) {
      const combined = new Float32Array(noiseBuf.length + normalized.length);
      combined.set(noiseBuf);
      combined.set(normalized, noiseBuf.length);
      noiseBuf = combined;

      if (noiseBuf.length >= NOISE_SAMPLES) {
        buildNoiseProfile(noiseBuf.slice(0, NOISE_SAMPLES));
        noiseReady = true;
        currentThreshold = calculateDynamicThreshold(noiseRms);
        console.log(`[MAP] Noise profile ready. RMS=${noiseRms.toFixed(4)}, threshold=${currentThreshold.toFixed(3)}`);

        // Feed remainder into session ring
        const ring2 = new Float32Array(sessionRing.length + noiseBuf.slice(NOISE_SAMPLES).length);
        ring2.set(sessionRing);
        ring2.set(noiseBuf.slice(NOISE_SAMPLES), sessionRing.length);
        sessionRing = ring2;
      } else {
        return;
      }
    } else {
      const ring2 = new Float32Array(sessionRing.length + normalized.length);
      ring2.set(sessionRing);
      ring2.set(normalized, sessionRing.length);
      sessionRing = ring2;
    }

    // Phase 2: Extract overlapping frames and compute per-frame features
    let offset = 0;
    while (offset + FRAME_SAMPLES <= sessionRing.length) {
      processFrame(sessionRing.slice(offset, offset + FRAME_SAMPLES));
      offset += HOP_SAMPLES;
    }
    sessionRing = sessionRing.slice(offset);

  } catch (err) {
    console.error('[MAP] process error:', err);
  }
}

function buildNoiseProfile(noisePcm) {
  // Compute noise RMS
  let sq = 0;
  for (let i = 0; i < noisePcm.length; i++) sq += noisePcm[i] * noisePcm[i];
  noiseRms = Math.sqrt(sq / noisePcm.length);

  // Compute average noise magnitude spectrum from noise frames
  let count = 0;
  let offset = 0;
  while (offset + FRAME_SAMPLES <= noisePcm.length) {
    const frame   = noisePcm.slice(offset, offset + FRAME_SAMPLES);
    const windowed = applyHanning(frame, FRAME_SAMPLES);
    const { re, im } = computeFFT(windowed, FFT_SIZE);
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      noiseMagProfile[i] += Math.sqrt(re[i]*re[i] + im[i]*im[i]);
    }
    count++;
    offset += HOP_SAMPLES;
  }
  if (count > 0) {
    for (let i = 0; i < FFT_SIZE / 2; i++) noiseMagProfile[i] /= count;
  }
}

function processFrame(frame) {
  const windowed = applyHanning(frame, FRAME_SAMPLES);
  const { re, im } = computeFFT(windowed, FFT_SIZE);

  const rawMag  = new Float32Array(FFT_SIZE / 2);
  const cleanMag = new Float32Array(FFT_SIZE / 2);
  const power    = new Float32Array(FFT_SIZE / 2);
  const logMag   = new Float32Array(FFT_SIZE / 2);

  for (let i = 0; i < FFT_SIZE / 2; i++) {
    rawMag[i] = Math.sqrt(re[i]*re[i] + im[i]*im[i]);

    // Spectral subtraction: X_clean = max(|X|² - α|N|², β|X|²)
    const rawPow   = rawMag[i] * rawMag[i];
    const noisePow = noiseMagProfile[i] * noiseMagProfile[i];
    const cleanPow = Math.max(rawPow - SS_ALPHA * noisePow, SS_BETA * rawPow);
    cleanMag[i]    = Math.sqrt(cleanPow);

    power[i]  = cleanPow;
    logMag[i] = Math.log10(Math.max(Number.EPSILON, cleanMag[i]));
  }

  // CSD vector: 4kHz–12kHz log-magnitude
  const csdVec = Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ));

  // Spectral Kurtosis: 3kHz–8kHz (bearing harmonics)
  const kurtosis = computeSpectralKurtosis(power, BIN_3KHZ, BIN_8KHZ);

  // Spectral Flatness (Wiener Entropy): 8kHz–12kHz (hiss / air leaks)
  const flatness = computeSpectralFlatness(power, BIN_8KHZ, BIN_12KHZ);

  frameVecs.push(csdVec);
  frameKurtoses.push(kurtosis);
  frameFlatnesses.push(flatness);
}

// ─── Stop Handler ─────────────────────────────────────────────────────────────
function handleStop() {
  try {
    // Process any remaining tail samples
    if (sessionRing.length > 0) {
      const padded = new Float32Array(FRAME_SAMPLES);
      padded.set(sessionRing.slice(0, Math.min(sessionRing.length, FRAME_SAMPLES)));
      processFrame(padded);
    }

    if (frameVecs.length === 0) { emitNormal(0); resetSession(); return; }

    // ── Session-level aggregated features ──────────────────────────────────
    const vecLen = frameVecs[0].length;

    // Average CSD vector
    const avgVec = new Array(vecLen).fill(0);
    for (const v of frameVecs) for (let i = 0; i < vecLen; i++) avgVec[i] += v[i];
    for (let i = 0; i < vecLen; i++) avgVec[i] /= frameVecs.length;

    const avgKurtosis = frameKurtoses.reduce((a, b) => a + b, 0) / frameKurtoses.length;
    const avgFlatness = frameFlatnesses.reduce((a, b) => a + b, 0) / frameFlatnesses.length;

    // Transient Score: STE derivative — detects sharp onset (Motor Starter)
    const transientScore = computeTransientScore(allSessionSamples);

    console.log(`[MAP] ${frameVecs.length} frames | Kurt=${avgKurtosis.toFixed(2)} | Flat=${avgFlatness.toFixed(3)} | Transient=${transientScore.toFixed(3)} | Thresh=${currentThreshold.toFixed(3)}`);

    // ── Match against reference index ──────────────────────────────────────
    let bestScore    = 0;
    let bestRaw      = 0;
    let bestMatch    = null;

    for (const ref of referenceIndex) {
      if (!Array.isArray(ref.cosine_vec) || ref.cosine_vec.length !== vecLen) continue;

      const W = FAULT_WEIGHTS[ref.fault_type] || FAULT_WEIGHTS['default'];

      // 1. Cosine similarity on CSD vector
      const cosSim = cosineSimilarity(avgVec, ref.cosine_vec);

      // 2. Kurtosis similarity (normalized distance)
      const refKurt  = ref.kurtosis_score ?? 3.0;
      const kurtSim  = 1 / (1 + Math.abs(avgKurtosis - refKurt) / (Math.max(refKurt, avgKurtosis, 1e-6)));

      // 3. Flatness similarity
      const refFlat  = ref.flatness_score ?? 0.5;
      const flatSim  = Math.max(0, 1 - Math.abs(avgFlatness - refFlat));

      // 4. Transient similarity
      const refTrans = ref.transient_score ?? 0.0;
      const transSim = 1 / (1 + Math.abs(transientScore - refTrans) / (Math.max(refTrans, transientScore, 1e-6) + 1e-6));

      // Weighted composite score
      const composite = W.cosine * cosSim + W.kurtosis * kurtSim + W.flatness * flatSim + W.transient * transSim;

      if (composite > bestScore) {
        bestScore = composite;
        bestRaw   = cosSim;
        bestMatch = ref;
      }
    }

    console.log(`[MAP] Best: "${bestMatch?.label}" | score=${bestScore.toFixed(3)} | threshold=${currentThreshold.toFixed(3)}`);

    if (bestScore >= currentThreshold && bestMatch) {
      self.postMessage({
        type: 'result',
        payload: {
          status:       'anomaly',
          anomaly:      bestMatch.label,
          confidence:   Math.min(1.0, bestScore),
          severity:     bestMatch.severity || 'high',
          rms:          noiseRms,
          spectralMeta: { kurtosis: avgKurtosis, flatness: avgFlatness, transient: transientScore, cosine: bestRaw, frames: frameVecs.length, threshold: currentThreshold }
        }
      });
    } else {
      emitNormal(bestScore);
    }

  } catch (err) {
    console.error('[MAP] handleStop error:', err);
    emitNormal(0);
  } finally {
    resetSession();
  }
}

function emitNormal(confidence) {
  self.postMessage({ type: 'result', payload: { status: 'normal', anomaly: null, confidence, rms: noiseRms } });
}

function resetSession() {
  sessionRing       = new Float32Array(0);
  allSessionSamples = [];
  frameVecs         = [];
  frameKurtoses     = [];
  frameFlatnesses   = [];
  noiseBuf          = new Float32Array(0);
  noiseReady        = false;
  noiseMagProfile   = new Float32Array(FFT_SIZE / 2);
  noiseRms          = 0;
  currentThreshold  = 0.58;
}

// ─── Adaptive SNR Threshold ──────────────────────────────────────────────────
function calculateDynamicThreshold(rms) {
  // Quiet room (low noise floor) → be more sensitive (lower threshold)
  // Loud environment → tighten threshold to prevent false positives
  if (rms < 0.02)  return 0.52;
  if (rms > 0.15)  return 0.65;
  const t = (rms - 0.02) / 0.13;
  return 0.52 + t * (0.65 - 0.52);
}

// ─── DSP Feature Extractors ───────────────────────────────────────────────────

/**
 * Spectral Kurtosis of the power spectrum within [binStart, binEnd].
 * For a Gaussian signal: kurtosis = 3.
 * For periodic/impulsive signals (bearing faults): kurtosis >> 3.
 */
function computeSpectralKurtosis(power, binStart, binEnd) {
  const N = binEnd - binStart;
  if (N <= 0) return 3;
  let sum = 0, sum2 = 0, sum4 = 0;
  for (let i = binStart; i < binEnd; i++) {
    const p = Math.max(Number.EPSILON, power[i]);
    sum  += p;
  }
  const mean = sum / N;
  if (mean < Number.EPSILON) return 3;
  for (let i = binStart; i < binEnd; i++) {
    const d = Math.max(Number.EPSILON, power[i]) - mean;
    sum2 += d * d;
    sum4 += d * d * d * d;
  }
  const variance = sum2 / N;
  if (variance < Number.EPSILON) return 3;
  return (sum4 / N) / (variance * variance); // normalized kurtosis
}

/**
 * Wiener Entropy / Spectral Flatness within [binStart, binEnd].
 * = geometric_mean / arithmetic_mean.
 * 0 → tonal (narrow band), 1 → white noise (perfect hiss/leak).
 */
function computeSpectralFlatness(power, binStart, binEnd) {
  const N = binEnd - binStart;
  if (N <= 0) return 0;
  let logSum = 0, arithmeticSum = 0;
  for (let i = binStart; i < binEnd; i++) {
    const p = Math.max(Number.EPSILON, power[i]);
    logSum        += Math.log(p);
    arithmeticSum += p;
  }
  const arithMean = Math.max(Number.EPSILON, arithmeticSum / N);
  return Math.exp(logSum / N) / arithMean;
}

/**
 * Transient Score via Short-Time Energy (STE) derivative.
 * High score → sharp energy onset (Motor Starter click).
 * Low score  → sustained / periodic energy (Water Pump).
 *
 * STE block = 10ms = 441 samples.
 * score = max(positive STE derivative) / (mean STE + ε)
 */
function computeTransientScore(samples) {
  if (!samples || samples.length === 0) return 0;
  const STE_BLOCK = Math.round(TARGET_SR * 0.01); // 441 samples @ 44.1kHz
  const steValues = [];

  for (let i = 0; i + STE_BLOCK <= samples.length; i += STE_BLOCK) {
    let sq = 0;
    for (let j = i; j < i + STE_BLOCK; j++) sq += samples[j] * samples[j];
    steValues.push(sq / STE_BLOCK);
  }

  if (steValues.length < 2) return 0;

  let maxPosDeriv = 0;
  let totalSte    = 0;
  for (let i = 1; i < steValues.length; i++) {
    const d = steValues[i] - steValues[i - 1];
    if (d > maxPosDeriv) maxPosDeriv = d;
    totalSte += steValues[i];
  }
  const meanSte = totalSte / (steValues.length - 1);
  return maxPosDeriv / (meanSte + Number.EPSILON);
}

// ─── Core DSP Primitives ──────────────────────────────────────────────────────
function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr, newLen = Math.floor(signal.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, l = Math.floor(idx), r = Math.min(l+1, signal.length-1);
    out[i] = signal[l]*(1-(idx-l)) + signal[r]*(idx-l);
  }
  return out;
}

function peakNormalize(signal) {
  let maxVal = 0;
  for (let i = 0; i < signal.length; i++) { const a = Math.abs(signal[i]); if (a > maxVal) maxVal = a; }
  if (maxVal < 1e-8) return signal;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] / maxVal;
  return out;
}

function applyHanning(signal, N) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = signal[i] * (0.5 * (1 - Math.cos((2*Math.PI*i)/(N-1))));
  return out;
}

function computeFFT(signal, N) {
  const re = new Float32Array(N), im = new Float32Array(N);
  const copyLen = Math.min(signal.length, N);
  for (let i = 0; i < copyLen; i++) re[i] = signal[i];
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2*Math.PI/len, wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < len/2; k++) {
        const uRe=re[i+k],uIm=im[i+k],vRe=re[i+k+len/2]*cRe-im[i+k+len/2]*cIm,vIm=re[i+k+len/2]*cIm+im[i+k+len/2]*cRe;
        re[i+k]=uRe+vRe;im[i+k]=uIm+vIm;re[i+k+len/2]=uRe-vRe;im[i+k+len/2]=uIm-vIm;
        const nRe=cRe*wRe-cIm*wIm; cIm=cRe*wIm+cIm*wRe; cRe=nRe;
      }
    }
  }
  return { re, im };
}

function cosineSimilarity(a, b) {
  let dot=0, nA=0, nB=0;
  const len = Math.min(a.length, b.length);
  for (let i=0; i<len; i++) { dot+=a[i]*b[i]; nA+=a[i]*a[i]; nB+=b[i]*b[i]; }
  return (nA>0 && nB>0) ? dot/(Math.sqrt(nA)*Math.sqrt(nB)) : 0;
}
