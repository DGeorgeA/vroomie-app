/**
 * AudioV6_Calibrator.worker.js — Precision Mechanical Gating Engine
 *
 * FIX: Eliminates false-positives on low-frequency engine rumble (Water Pump misclassifications).
 *
 * PIPELINE (audio_v6_calibration = true):
 *   1. Resample & Peak-Normalize
 *   2. Noise Profile with Clamped SNR: Math.max(0.01, noiseRms)
 *   3. AM Envelope Extraction (100Hz–500Hz): Modulation Index > 0.2 required for Water Pump.
 *   4. Harmonic-to-Noise Ratio (HNR): Strong harmonics penalize mechanical fault scores.
 *   5. Healthy Engine Baseline: Hard negative control profile.
 */

const TARGET_SR     = 44100;
const FFT_SIZE      = 4096;           // Frame = 93ms
const FRAME_SAMPLES = FFT_SIZE;
const HOP_SAMPLES   = FFT_SIZE >> 1;  // 50% overlap

const BIN_100HZ = Math.round(100   * FFT_SIZE / TARGET_SR);
const BIN_500HZ = Math.round(500   * FFT_SIZE / TARGET_SR);
const BIN_3KHZ  = Math.round(3000  * FFT_SIZE / TARGET_SR);
const BIN_4KHZ  = Math.round(4000  * FFT_SIZE / TARGET_SR);
const BIN_8KHZ  = Math.round(8000  * FFT_SIZE / TARGET_SR);
const BIN_10KHZ = Math.round(10000 * FFT_SIZE / TARGET_SR); // Bearing peak band upper bound
const BIN_12KHZ = Math.round(12000 * FFT_SIZE / TARGET_SR);

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
let frameHFCentroids  = [];  // spectral centroid in 4kHz-10kHz per frame
let frameHFFlatnesses = [];  // flatness in 4kHz-10kHz per frame (separate from 8-12kHz)
let clippedFrameCount = 0;   // frames where max sample > 0.98 (clipping/bump)
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

  // Clipping detection: mic bumps and hard transients push samples to 0dBFS
  const maxSample = frame.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (maxSample > 0.98) {
    clippedFrameCount++;
    // Still push placeholders so array lengths stay in sync
    frameVecs.push(Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ)));
    frameKurtoses.push(3.0);      // Gaussian default = not a fault
    frameFlatnesses.push(0.5);
    frameHFCentroids.push(-1);    // -1 = invalid (clipped)
    frameHFFlatnesses.push(1.0);  // High flatness = noise, blocks bearing override
    lfEnvelopes.push(0);
    return;
  }

  frameVecs.push(Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ)));
  // Bearing kurtosis: 4kHz-10kHz band
  frameKurtoses.push(computeSpectralKurtosis(power, BIN_4KHZ, BIN_10KHZ));
  // Flatness: 8kHz-12kHz band (broadband hiss / air leak)
  frameFlatnesses.push(computeSpectralFlatness(power, BIN_8KHZ, BIN_12KHZ));
  // HF centroid in 4kHz-10kHz (for tonal stability check)
  frameHFCentroids.push(computeSpectralCentroid(power, BIN_4KHZ, BIN_10KHZ));
  // HF flatness in 4kHz-10kHz (must be LOW for a real tonal bearing whine)
  frameHFFlatnesses.push(computeSpectralFlatness(power, BIN_4KHZ, BIN_10KHZ));
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

    const vecLen = frameVecs[0].length;
    const avgVec = new Array(vecLen).fill(0);
    for (const v of frameVecs) for (let i = 0; i < vecLen; i++) avgVec[i] += v[i];
    for (let i = 0; i < vecLen; i++) avgVec[i] /= frameVecs.length;

    const avgKurtosis = frameKurtoses.reduce((a, b) => a + b, 0) / frameKurtoses.length;
    const avgFlatness = frameFlatnesses.reduce((a, b) => a + b, 0) / frameFlatnesses.length;
    
    // Feature A: Amplitude Modulation Depth (100Hz-500Hz)
    const amDepth = computeAMDepth(lfEnvelopes);
    
    // Feature B: Harmonic-to-Noise Ratio (HNR)
    const hnr = computeHNR(allSessionSamples);
    
    // Feature C: Transient Score
    const transientScore = computeTransientScore(allSessionSamples);

    console.log(`[V6 Worker] AM_Depth=${amDepth.toFixed(3)} | HNR=${hnr.toFixed(3)} | Kurt=${avgKurtosis.toFixed(2)} | Flat=${avgFlatness.toFixed(3)}`);

    // ─── HARD BYPASS: Sub-band overrides skip the normal threshold gate ───────
    // These fire when a specific physical signature is unambiguous,
    // regardless of cosine score or ambient noise.

    // BEARING OVERRIDE: Requires ALL THREE conditions to prevent false positives:
    // 1. PeakKurtosis > threshold (high impulsiveness in 4kHz-10kHz)
    // 2. avgHFFlatness < 0.50 (it's a TONAL whine, not broadband wind/noise)
    // 3. verifyTonalStability() passes (centroid stable >370ms = NOT a mic bump)
    const peakKurtosis = frameKurtoses.length > 0 ? Math.max(...frameKurtoses) : 0;
    const avgHFFlatness = frameHFFlatnesses.length > 0
      ? frameHFFlatnesses.filter(v => v >= 0).reduce((a, b) => a + b, 0) / Math.max(1, frameHFFlatnesses.filter(v => v >= 0).length)
      : 1.0;
    const clippingRatio = clippedFrameCount / Math.max(1, frameVecs.length);
    const tonallyStable = verifyTonalStability(frameHFCentroids);

    console.log(`[V6] Bearing check: PeakKurt=${peakKurtosis.toFixed(1)} HFFlatness=${avgHFFlatness.toFixed(3)} Stable=${tonallyStable} ClipRatio=${clippingRatio.toFixed(2)}`);

    if (
      peakKurtosis > BEARING_KURTOSIS_OVERRIDE &&
      avgHFFlatness < 0.50 &&           // must be TONAL (low flatness), not noise
      tonallyStable &&                   // centroid must be stable for ≥370ms
      clippingRatio < 0.25               // <25% clipped frames (not a mic bump)
    ) {
      const bearingRef = referenceIndex.find(r =>
        r.fault_type === 'alternator_bearing_fault' ||
        (r.label && r.label.toLowerCase().includes('bearing'))
      );
      if (bearingRef) {
        console.log(`[V6 Worker] BEARING OVERRIDE triggered. PeakKurt=${peakKurtosis.toFixed(1)} HFFlat=${avgHFFlatness.toFixed(3)}`);
        self.postMessage({
          type: 'result',
          payload: {
            status: 'anomaly', anomaly: bearingRef.label,
            confidence: Math.min(1.0, 0.70 + Math.min(0.25, (peakKurtosis - BEARING_KURTOSIS_OVERRIDE) / 100)),
            severity: bearingRef.severity || 'critical',
            rms: Math.max(MIN_NOISE_FLOOR, noiseRms),
            spectralMeta: { kurtosis: avgKurtosis, peakKurtosis, hfFlatness: avgHFFlatness, tonallyStable, override: 'bearing_kurtosis' }
          }
        });
        resetSession();
        return;
      }
    }

    // INTAKE LEAK OVERRIDE: Flatness > 0.65 in 8kHz-12kHz = broadband hiss.
    if (avgFlatness > INTAKE_FLATNESS_OVERRIDE) {
      const leakRef = referenceIndex.find(r =>
        r.fault_type === 'intake_leak' ||
        (r.label && r.label.toLowerCase().includes('intake'))
      );
      if (leakRef) {
        console.log(`[V6 Worker] INTAKE LEAK OVERRIDE triggered. Flatness=${avgFlatness.toFixed(3)}`);
        self.postMessage({
          type: 'result',
          payload: {
            status: 'anomaly', anomaly: leakRef.label,
            confidence: Math.min(1.0, 0.65 + Math.min(0.30, (avgFlatness - INTAKE_FLATNESS_OVERRIDE) * 2)),
            severity: leakRef.severity || 'low',
            rms: Math.max(MIN_NOISE_FLOOR, noiseRms),
            spectralMeta: { kurtosis: avgKurtosis, flatness: avgFlatness, override: 'intake_flatness' }
          }
        });
        resetSession();
        return;
      }
    }
    // ──────────────────────────────────────────────────────────────────────────


    let bestScore = 0;
    let bestRaw = 0;
    let bestMatch = null;

    // 1. Compute Healthy Engine Baseline Distance (Hard Negative)
    // A healthy engine is strongly harmonic (High HNR), has steady low frequency rumble (Low AM Depth)
    const baselineDistance = Math.max(0, 1.0 - (hnr * 0.5 + (1 - amDepth) * 0.5)); 
    // Higher HNR and lower AM depth = closer to healthy engine (smaller distance)

    for (const ref of referenceIndex) {
      if (!Array.isArray(ref.cosine_vec) || ref.cosine_vec.length !== vecLen) continue;

      const W = FAULT_WEIGHTS[ref.fault_type] || FAULT_WEIGHTS['default'];
      const cosSim = cosineSimilarity(avgVec, ref.cosine_vec);
      
      const refKurt = ref.kurtosis_score ?? 3.0;
      const kurtSim = 1 / (1 + Math.abs(avgKurtosis - refKurt) / (Math.max(refKurt, avgKurtosis, 1e-6)));
      
      const refFlat = ref.flatness_score ?? 0.5;
      const flatSim = Math.max(0, 1 - Math.abs(avgFlatness - refFlat));
      
      const refTrans = ref.transient_score ?? 0.0;
      const transSim = 1 / (1 + Math.abs(transientScore - refTrans) / (Math.max(refTrans, transientScore, 1e-6) + 1e-6));

      let composite = W.cosine * cosSim + W.kurtosis * kurtSim + W.flatness * flatSim + W.transient * transSim;

      // --- GATING LOGIC ---

      // Water Pump Gating: Requires high AM Depth (grind/wobble)
      if (ref.fault_type === 'water_pump' || ref.label.includes('water_pump')) {
        if (amDepth < 0.20) {
          composite *= 0.1; // Severely penalize steady drone
        } else {
          // Boost based on AM depth
          composite += Math.min(0.2, (amDepth - 0.2) * 0.5);
        }
        // Hard threshold requirement
        if (cosSim < 0.94) composite *= 0.5;
      }

      // HNR Penalty: If the signal is perfectly harmonic (HNR > 0.8), it's likely a healthy revving engine.
      // Penalize mechanical fault scores (which should introduce chaotic broadband noise).
      if (hnr > 0.8 && ref.fault_type !== 'healthy') {
        composite *= 0.7; // 30% penalty for being too "clean"
      }

      if (composite > bestScore) {
        bestScore = composite;
        bestRaw = cosSim;
        bestMatch = ref;
      }
    }

    // Hard Negative Rejection
    // If the signal is closer to the Healthy Baseline than to the best anomaly match
    const anomalyDistance = 1.0 - bestScore;
    if (baselineDistance < anomalyDistance && hnr > 0.6 && amDepth < 0.25) {
      console.log(`[V6 Worker] REJECTED. Closer to Healthy Engine. BaselineDist=${baselineDistance.toFixed(3)} < AnomalyDist=${anomalyDistance.toFixed(3)}`);
      emitNormal(bestScore);
      return;
    }

    // Final Adaptive Threshold Check
    // Water Pump requires 0.94. Others use clamped threshold.
    let requiredThreshold = clampedThreshold;
    if (bestMatch && bestMatch.fault_type === 'water_pump') requiredThreshold = 0.94;

    console.log(`[V6 Worker] Best: "${bestMatch?.label}" | score=${bestScore.toFixed(3)} | req_thresh=${requiredThreshold.toFixed(3)}`);

    if (bestScore >= requiredThreshold && bestMatch) {
      self.postMessage({
        type: 'result',
        payload: {
          status: 'anomaly',
          anomaly: bestMatch.label,
          confidence: Math.min(1.0, bestScore),
          severity: bestMatch.severity || 'high',
          rms: Math.max(MIN_NOISE_FLOOR, noiseRms),
          spectralMeta: { 
            kurtosis: avgKurtosis, 
            flatness: avgFlatness, 
            transient: transientScore, 
            amDepth: amDepth,
            hnr: hnr,
            cosine: bestRaw, 
            threshold: requiredThreshold 
          }
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
  clippedFrameCount = 0;
  lfEnvelopes = [];
  noiseBuf = new Float32Array(0);
  noiseReady = false;
  noiseMagProfile = new Float32Array(FFT_SIZE / 2);
  noiseRms = 0;
  clampedThreshold = 0.65;
}

function calculateClampedThreshold(rms) {
  if (rms <= MIN_NOISE_FLOOR) return 0.65; // Prevent oversensitivity in absolute silence
  if (rms > 0.15) return 0.70;
  const t = (rms - MIN_NOISE_FLOOR) / (0.15 - MIN_NOISE_FLOOR);
  return 0.65 + t * (0.70 - 0.65);
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
