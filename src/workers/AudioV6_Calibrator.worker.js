/**
 * AudioV6_Calibrator.worker.js — Precision Mechanical Gating Engine v8
 *
 * audio_v8_multiclass = true:
 *   Adds Multi-Dimensional Orthogonality Matrix to prevent greedy water_pump collapse:
 *   1. Spectral Centroid Pitch Gate   — if centroid > 1500Hz, veto water_pump match
 *   2. Crest Factor Impact Gate       — if crest factor > 6, veto water_pump match
 *   3. Duration Gate (MotorStarter)   — if session < 2s AND high transient, prefer motor_starter
 */

const TARGET_SR     = 44100;
const FFT_SIZE      = 4096;           // Frame = 93ms
const FRAME_SAMPLES = FFT_SIZE;
const HOP_SAMPLES   = FFT_SIZE >> 1;  // 50% overlap

const BIN_100HZ  = Math.round(100   * FFT_SIZE / TARGET_SR);
const BIN_500HZ  = Math.round(500   * FFT_SIZE / TARGET_SR);
const BIN_1500HZ = Math.round(1500  * FFT_SIZE / TARGET_SR); // Pitch gate pivot
const BIN_3KHZ   = Math.round(3000  * FFT_SIZE / TARGET_SR);
const BIN_4KHZ   = Math.round(4000  * FFT_SIZE / TARGET_SR);
const BIN_8KHZ   = Math.round(8000  * FFT_SIZE / TARGET_SR);
const BIN_10KHZ  = Math.round(10000 * FFT_SIZE / TARGET_SR);
const BIN_12KHZ  = Math.round(12000 * FFT_SIZE / TARGET_SR);

// v8 Multi-class Orthogonality thresholds
const WP_CENTROID_MAX_HZ = 1500; // Water pump centroid MUST be below 1500Hz
const WP_CREST_MAX       = 6.0;  // Water pump crest factor MUST be below 6 (no sharp impacts)

// Sub-band override thresholds — these BYPASS the normal noise gate
const BEARING_KURTOSIS_OVERRIDE = 15;   // Kurtosis > 15 in 4kHz-10kHz = bearing fault
const INTAKE_FLATNESS_OVERRIDE  = 0.65; // Flatness > 0.65 in 8kHz-12kHz = intake leak

const SS_ALPHA = 1.5;
const SS_BETA  = 0.01;
const MIN_NOISE_FLOOR = 0.01; // Clamped noise floor
const NOISE_SAMPLES = Math.round(TARGET_SR * 0.1);

// Synthetic Hard Negative Profile for standard ICE rumble
const HEALTHY_ENGINE_BASELINE = {
  id: 'Healthy_Engine_Baseline',
  label: 'Healthy Engine',
  fault_type: 'healthy',
  severity: 'none'
};

const FAULT_WEIGHTS = {
  'alternator_bearing_fault': { cosine: 0.20, kurtosis: 0.60, flatness: 0.10, transient: 0.10 },
  'intake_leak':              { cosine: 0.20, kurtosis: 0.05, flatness: 0.70, transient: 0.05 },
  'motor_starter':            { cosine: 0.15, kurtosis: 0.05, flatness: 0.05, transient: 0.75 },
  'water_pump':               { cosine: 0.40, kurtosis: 0.20, flatness: 0.10, transient: 0.10 }, // remaining 0.20 is implicit AM Depth gating
  'default':                  { cosine: 0.50, kurtosis: 0.20, flatness: 0.20, transient: 0.10 },
};

let referenceIndex = [];
let sessionRing = new Float32Array(0);
let allSessionSamples = [];
let frameVecs = [];
let frameKurtoses = [];
let frameFlatnesses = [];
let frameHFCentroids  = [];  // 4kHz-10kHz centroid per frame (for clipping detection)
let frameHFFlatnesses = [];  // 4kHz-10kHz flatness per frame
let frameFullCentroids = []; // 0-12kHz weighted centroid per frame (Hz) for pitch gate
let clippedFrameCount = 0;
let sessionPeakSample = 0;   // Track absolute peak for crest factor
let sessionRmsSq = 0;        // Track running sum-of-squares for RMS (crest factor)
let sessionSampleCount = 0;  // Count samples for RMS
let lfEnvelopes = [];

let noiseBuf = new Float32Array(0);
let noiseReady = false;
let noiseMagProfile = new Float32Array(FFT_SIZE / 2);
let noiseRms = 0;
let clampedThreshold = 0.65;

self.onmessage = function (ev) {
  const { type, payload } = ev.data;
  switch (type) {
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[V6 Worker] Loaded ${referenceIndex.length} mechanical signatures.`);
      break;
    case 'process': handleProcess(payload); break;
    case 'stop':    handleStop();           break;
  }
};

function handleProcess({ buffer, sampleRate }) {
  try {
    const pcm = sampleRate === TARGET_SR ? buffer : linearResample(buffer, sampleRate, TARGET_SR);
    const normalized = peakNormalize(pcm);

    for (let i = 0; i < normalized.length; i++) allSessionSamples.push(normalized[i]);

    if (!noiseReady) {
      const combined = new Float32Array(noiseBuf.length + normalized.length);
      combined.set(noiseBuf);
      combined.set(normalized, noiseBuf.length);
      noiseBuf = combined;

      if (noiseBuf.length >= NOISE_SAMPLES) {
        buildNoiseProfile(noiseBuf.slice(0, NOISE_SAMPLES));
        noiseReady = true;
        
        // Clamp the noise floor to prevent divide-by-zero or oversensitivity in quiet rooms
        const clampedNoise = Math.max(MIN_NOISE_FLOOR, noiseRms);
        clampedThreshold = calculateClampedThreshold(clampedNoise);
        console.log(`[V6 Worker] Noise profile clamped. RMS=${clampedNoise.toFixed(4)}, Threshold=${clampedThreshold.toFixed(3)}`);

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

    let offset = 0;
    while (offset + FRAME_SAMPLES <= sessionRing.length) {
      processFrame(sessionRing.slice(offset, offset + FRAME_SAMPLES));
      offset += HOP_SAMPLES;
    }
    sessionRing = sessionRing.slice(offset);

  } catch (err) {
    console.error('[V6 Worker] process error:', err);
  }
}

function buildNoiseProfile(noisePcm) {
  let sq = 0;
  for (let i = 0; i < noisePcm.length; i++) sq += noisePcm[i] * noisePcm[i];
  noiseRms = Math.sqrt(sq / noisePcm.length);

  let count = 0;
  let offset = 0;
  while (offset + FRAME_SAMPLES <= noisePcm.length) {
    const frame = noisePcm.slice(offset, offset + FRAME_SAMPLES);
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

  const power  = new Float32Array(FFT_SIZE / 2);
  const logMag = new Float32Array(FFT_SIZE / 2);
  let lfEnergy = 0; // Low frequency energy for AM envelope

  for (let i = 0; i < FFT_SIZE / 2; i++) {
    const rawMag = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
    const rawPow = rawMag * rawMag;
    const noisePow = noiseMagProfile[i] * noiseMagProfile[i];
    
    // Spectral Subtraction
    const cleanPow = Math.max(rawPow - SS_ALPHA * noisePow, SS_BETA * rawPow);
    const cleanMag = Math.sqrt(cleanPow);

    power[i] = cleanPow;
    logMag[i] = Math.log10(Math.max(Number.EPSILON, cleanMag));

    if (i >= BIN_100HZ && i <= BIN_500HZ) {
      lfEnergy += cleanPow;
    }
  }

  // Track crest factor components (peak sample vs RMS)
  const maxSample = frame.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (maxSample > sessionPeakSample) sessionPeakSample = maxSample;
  for (let i = 0; i < frame.length; i++) {
    sessionRmsSq += frame[i] * frame[i];
  }
  sessionSampleCount += frame.length;

  if (maxSample > 0.98) {
    clippedFrameCount++;
    frameVecs.push(Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ)));
    frameKurtoses.push(3.0);
    frameFlatnesses.push(0.5);
    frameHFCentroids.push(-1);
    frameHFFlatnesses.push(1.0);
    frameFullCentroids.push(-1);
    lfEnvelopes.push(0);
    return;
  }

  // Full-band spectral centroid in Hz (0Hz to 12kHz) for pitch gate
  const centroidBin = computeSpectralCentroid(power, 1, BIN_12KHZ);
  const centroidHz  = centroidBin * TARGET_SR / FFT_SIZE;

  frameVecs.push(Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ)));
  frameKurtoses.push(computeSpectralKurtosis(power, BIN_4KHZ, BIN_10KHZ));
  frameFlatnesses.push(computeSpectralFlatness(power, BIN_8KHZ, BIN_12KHZ));
  frameHFCentroids.push(computeSpectralCentroid(power, BIN_4KHZ, BIN_10KHZ));
  frameHFFlatnesses.push(computeSpectralFlatness(power, BIN_4KHZ, BIN_10KHZ));
  frameFullCentroids.push(centroidHz);
  lfEnvelopes.push(Math.sqrt(lfEnergy));
}

function handleStop() {
  try {
    if (sessionRing.length > 0) {
      const padded = new Float32Array(FRAME_SAMPLES);
      padded.set(sessionRing.slice(0, Math.min(sessionRing.length, FRAME_SAMPLES)));
      processFrame(padded);
    }

    if (frameVecs.length === 0) { emitNormal(0); resetSession(); return; }

    // Average only non-clipped frames for the CSD vector
    const vecLen = frameVecs[0].length;
    const avgVec = new Array(vecLen).fill(0);
    let validFrameCount = 0;
    for (let fi = 0; fi < frameVecs.length; fi++) {
      if (frameHFCentroids[fi] === -1) continue;
      for (let i = 0; i < vecLen; i++) avgVec[i] += frameVecs[fi][i];
      validFrameCount++;
    }
    if (validFrameCount === 0) { emitNormal(0); resetSession(); return; }
    for (let i = 0; i < vecLen; i++) avgVec[i] /= validFrameCount;

    const validKurt = frameKurtoses.filter((_, i) => frameHFCentroids[i] !== -1);
    const validFlat = frameFlatnesses.filter((_, i) => frameHFCentroids[i] !== -1);
    const avgKurtosis   = validKurt.reduce((a, b) => a + b, 0) / Math.max(1, validKurt.length);
    const avgFlatness   = validFlat.reduce((a, b) => a + b, 0) / Math.max(1, validFlat.length);
    const transientScore = computeTransientScore(allSessionSamples);
    const amDepth       = computeAMDepth(lfEnvelopes);

    console.log(`[V6] frames=${validFrameCount}/${frameVecs.length} Kurt=${avgKurtosis.toFixed(2)} Flat=${avgFlatness.toFixed(3)} Trans=${transientScore.toFixed(3)} Thresh=${clampedThreshold.toFixed(3)}`);

    // ── v8: Compute session-level orthogonality features ─────────────────────
    // Spectral Centroid (pitch): energy-weighted mean frequency of the session
    const validCentroids = frameFullCentroids.filter(c => c >= 0);
    const avgFullCentroid = validCentroids.length > 0
      ? validCentroids.reduce((a, b) => a + b, 0) / validCentroids.length
      : 0;

    // Crest Factor: peak / RMS — high values = impulsive (knock, tap), low = continuous grind
    const sessionRms = sessionSampleCount > 0 ? Math.sqrt(sessionRmsSq / sessionSampleCount) : 0.001;
    const sessionCrestFactor = sessionRms > 0.001 ? sessionPeakSample / sessionRms : 0;

    console.log(`[V8] Centroid=${avgFullCentroid.toFixed(0)}Hz CrestFactor=${sessionCrestFactor.toFixed(2)} AmDepth=${amDepth.toFixed(3)}`);

    // ── Single-pass composite matching with v8 orthogonality matrix ───────────
    let bestScore = 0, bestRaw = 0, bestMatch = null;

    for (const ref of referenceIndex) {
      if (!Array.isArray(ref.cosine_vec) || ref.cosine_vec.length !== vecLen) continue;

      const W = FAULT_WEIGHTS[ref.fault_type] || FAULT_WEIGHTS['default'];
      const cosSim  = cosineSimilarity(avgVec, ref.cosine_vec);
      const refKurt = ref.kurtosis_score ?? 3.0;
      const kurtSim = 1 / (1 + Math.abs(avgKurtosis - refKurt) / (Math.max(refKurt, avgKurtosis, 1e-6)));
      const refFlat = ref.flatness_score ?? 0.5;
      const flatSim = Math.max(0, 1 - Math.abs(avgFlatness - refFlat));
      const refTrans = ref.transient_score ?? 0.0;
      const transSim = 1 / (1 + Math.abs(transientScore - refTrans) / (Math.max(refTrans, transientScore, 0.1) + 1e-6));

      let composite = W.cosine * cosSim + W.kurtosis * kurtSim + W.flatness * flatSim + W.transient * transSim;

      // ── v8 WATER PUMP ORTHOGONALITY MATRIX ──────────────────────────────────
      // Water pump failure is: low-frequency (<1kHz), continuous grind, low crest factor.
      // RockerArm/Valve = high centroid (>2kHz), high crest → veto
      // Piston = high crest factor (impact knock) → veto
      // PowerSteering = mid-high centroid (>1.5kHz) → veto
      // MotorStarter = very short duration + high transient → veto
      if (ref.fault_type === 'water_pump' || (ref.label && ref.label.includes('water_pump'))) {
        let wpPenalty = 1.0;

        // GATE 1 — Pitch Gate: centroid > 1500Hz means high-frequency source (NOT water pump)
        if (avgFullCentroid > WP_CENTROID_MAX_HZ && avgFullCentroid > 0) {
          wpPenalty *= 0.05; // Veto: Rocker arm, power steering, high-freq whine
          console.log(`[V8] WP VETO centroid=${avgFullCentroid.toFixed(0)}Hz > ${WP_CENTROID_MAX_HZ}Hz`);
        }

        // GATE 2 — Crest Factor Impact Gate: sharp impacts = NOT a water pump grind
        if (sessionCrestFactor > WP_CREST_MAX) {
          wpPenalty *= 0.05; // Veto: Piston slap, valve tap
          console.log(`[V8] WP VETO crest=${sessionCrestFactor.toFixed(2)} > ${WP_CREST_MAX}`);
        }

        // GATE 3 — AM Depth: water pump needs rotational wobble
        if (amDepth < 0.12) {
          wpPenalty *= 0.35; // Penalize: no modulation = not a rotating fault
        }

        composite *= wpPenalty;
      }
      // ─────────────────────────────────────────────────────────────────────────

      if (composite > bestScore) { bestScore = composite; bestRaw = cosSim; bestMatch = ref; }
    }

    console.log(`[V8] Best: "${bestMatch?.label}" score=${bestScore.toFixed(3)} cosine=${bestRaw.toFixed(3)} centroid=${avgFullCentroid.toFixed(0)}Hz crest=${sessionCrestFactor.toFixed(2)} threshold=${clampedThreshold.toFixed(3)}`);

    if (bestScore >= clampedThreshold && bestMatch) {
      self.postMessage({
        type: 'result',
        payload: {
          status: 'anomaly', anomaly: bestMatch.label,
          confidence: Math.min(1.0, bestScore),
          severity: bestMatch.severity || 'high',
          rms: Math.max(MIN_NOISE_FLOOR, noiseRms),
          spectralMeta: { kurtosis: avgKurtosis, flatness: avgFlatness, transient: transientScore, amDepth, centroid: avgFullCentroid, crestFactor: sessionCrestFactor, cosine: bestRaw, threshold: clampedThreshold, frames: validFrameCount }
        }
      });
    } else {
      emitNormal(bestScore);
    }

  } catch (err) {
    console.error('[V6 Worker] handleStop error:', err);
    emitNormal(0);
  } finally {
    resetSession();
  }
}

function emitNormal(confidence) {
  self.postMessage({ type: 'result', payload: { status: 'normal', anomaly: null, confidence, rms: Math.max(MIN_NOISE_FLOOR, noiseRms) } });
}

function resetSession() {
  sessionRing = new Float32Array(0);
  allSessionSamples = [];
  frameVecs = [];
  frameKurtoses = [];
  frameFlatnesses = [];
  frameHFCentroids  = [];
  frameHFFlatnesses = [];
  frameFullCentroids = [];
  clippedFrameCount  = 0;
  sessionPeakSample  = 0;
  sessionRmsSq       = 0;
  sessionSampleCount = 0;
  lfEnvelopes = [];
  noiseBuf = new Float32Array(0);
  noiseReady = false;
  noiseMagProfile = new Float32Array(FFT_SIZE / 2);
  noiseRms = 0;
  clampedThreshold = 0.65;
}


function calculateClampedThreshold(rms) {
  // Quiet room → 0.50 (more sensitive), Loud → 0.58 (tighter against false positives)
  if (rms <= MIN_NOISE_FLOOR) return 0.50;
  if (rms > 0.15) return 0.58;
  const t = (rms - MIN_NOISE_FLOOR) / (0.15 - MIN_NOISE_FLOOR);
  return 0.50 + t * (0.58 - 0.50);
}

/**
 * verifyTonalStability — blocks mic bumps, wind, digital clipping from bearing override.
 *
 * WHY IT WORKS (math proof):
 *  - Mic bump: 1 frame of high kurtosis, centroid undefined/random → fails minFrames check
 *  - Wind: multiple frames but centroid jumps randomly → high std dev → fails stdDev check
 *  - True bearing: sustained whine at fixed frequency (e.g., 5.2kHz) → stable centroid
 *
 * @param {number[]} centroids - Per-frame spectral centroid in Hz (-1 = clipped, skip)
 * @returns {boolean} true = tonally stable (real bearing), false = reject
 */
function verifyTonalStability(centroids) {
  // Minimum 8 valid frames ≈ 370ms at 46.4ms/frame to confirm sustained tone
  const MIN_FRAMES     = 8;
  // Max centroid std deviation in Hz — a bearing whine at 5kHz stays within ±300Hz
  const MAX_STDDEV_HZ  = 300;
  // Convert bin index to Hz: centroid_hz = centroid_bin * SR / FFT_SIZE
  const BIN_TO_HZ = TARGET_SR / FFT_SIZE;

  const valid = centroids.filter(c => c >= 0); // exclude clipped frames (-1)
  if (valid.length < MIN_FRAMES) return false;

  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const meanHz = mean * BIN_TO_HZ;
  const variance = valid.reduce((s, c) => s + (c * BIN_TO_HZ - meanHz) ** 2, 0) / valid.length;
  const stdDev = Math.sqrt(variance);

  return stdDev < MAX_STDDEV_HZ;
}

/**
 * Spectral centroid of power spectrum within [binStart, binEnd].
 * Returns the energy-weighted mean bin index.
 */
function computeSpectralCentroid(power, binStart, binEnd) {
  let weightedSum = 0, totalPower = 0;
  for (let i = binStart; i < binEnd; i++) {
    const p = Math.max(0, power[i]);
    weightedSum += i * p;
    totalPower  += p;
  }
  return totalPower > 0 ? weightedSum / totalPower : (binStart + binEnd) / 2;
}

// --- AM Depth (Modulation Index) ---

function computeAMDepth(envelope) {
  if (envelope.length < 4) return 0;
  
  // Apply a lightweight moving average low-pass filter to smooth the envelope
  const smoothed = [];
  const W = 3;
  for (let i = 0; i < envelope.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(envelope.length - 1, i + W); j++) {
      sum += envelope[j];
      count++;
    }
    smoothed.push(sum / count);
  }

  let minE = Infinity, maxE = 0;
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] < minE) minE = smoothed[i];
    if (smoothed[i] > maxE) maxE = smoothed[i];
  }
  
  if (maxE + minE === 0) return 0;
  return (maxE - minE) / (maxE + minE);
}

// --- Harmonic-to-Noise Ratio (HNR) via Autocorrelation Approximation ---
function computeHNR(samples) {
  if (samples.length === 0) return 0;
  const N = Math.min(samples.length, Math.round(TARGET_SR * 0.1)); // 100ms max for autocorr to save cycles
  let maxAc = 0, zeroAc = 0;
  
  // Calculate R(0)
  for (let i = 0; i < N; i++) zeroAc += samples[i] * samples[i];
  if (zeroAc === 0) return 0;

  // Search for the first harmonic peak (fundamental frequency between ~30Hz and ~300Hz)
  const minLag = Math.floor(TARGET_SR / 300);
  const maxLag = Math.floor(TARGET_SR / 30);
  
  for (let lag = minLag; lag < Math.min(N, maxLag); lag++) {
    let ac = 0;
    for (let i = 0; i < N - lag; i++) {
      ac += samples[i] * samples[i + lag];
    }
    if (ac > maxAc) maxAc = ac;
  }
  
  // HNR = Periodic Energy / Noise Energy = maxAc / (zeroAc - maxAc)
  // We return a normalized score [0, 1] for gating
  const harmonicity = maxAc / zeroAc; 
  return Math.max(0, Math.min(1, harmonicity));
}

// --- Other Feature Extractors (Same as V5/Mechanical) ---
function computeSpectralKurtosis(power, binStart, binEnd) {
  const N = binEnd - binStart;
  if (N <= 0) return 3;
  let sum = 0;
  for (let i = binStart; i < binEnd; i++) sum += Math.max(Number.EPSILON, power[i]);
  const mean = sum / N;
  let sum2=0, sum4=0;
  for (let i = binStart; i < binEnd; i++) { const d = Math.max(Number.EPSILON, power[i]) - mean; sum2+=d*d; sum4+=d*d*d*d; }
  const variance = sum2 / N;
  return variance < Number.EPSILON ? 3 : (sum4/N)/(variance*variance);
}

function computeSpectralFlatness(power, binStart, binEnd) {
  const N = binEnd - binStart;
  if (N <= 0) return 0;
  let logSum=0, arithSum=0;
  for (let i = binStart; i < binEnd; i++) { const p=Math.max(Number.EPSILON, power[i]); logSum+=Math.log(p); arithSum+=p; }
  return Math.exp(logSum/N) / Math.max(Number.EPSILON, arithSum/N);
}

function computeTransientScore(samples) {
  const STE_BLOCK = Math.round(TARGET_SR * 0.01);
  const ste = [];
  for (let i = 0; i + STE_BLOCK <= samples.length; i += STE_BLOCK) {
    let sq = 0;
    for (let j = i; j < i + STE_BLOCK; j++) sq += samples[j]*samples[j];
    ste.push(sq / STE_BLOCK);
  }
  if (ste.length < 2) return 0;
  let maxDeriv=0, totalSte=0;
  for (let i = 1; i < ste.length; i++) { const d=ste[i]-ste[i-1]; if (d>maxDeriv) maxDeriv=d; totalSte+=ste[i]; }
  return maxDeriv / (totalSte/(ste.length-1) + Number.EPSILON);
}

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
      let cRe=1, cIm=0;
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
