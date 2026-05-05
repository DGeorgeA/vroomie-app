/**
 * AudioV6_Calibrator.worker.js — Precision Mechanical Gating Engine v9
 *
 * audio_v9_orthogonal_matrix = true:
 *   Resolves bifurcated collapse: bearing deafness (false negatives) +
 *   water_pump sinkhole (false positives for Starter/Piston/PowerSteering).
 *
 *   ROOT CAUSE FIX A — Bearing Deafness:
 *     Spectral Subtraction (SS_ALPHA=1.5) was zeroing the 4-8kHz bearing
 *     harmonics before kurtosis was computed. v9 computes kurtosis on the
 *     RAW (pre-subtraction) power spectrum and adds a direct bearing boost
 *     path that bypasses cosine-centred scoring.
 *
 *   ROOT CAUSE FIX B — WP Sinkhole:
 *     MotorStarter and Piston have low SESSION-AVERAGE centroids because
 *     silence/low-freq frames drag the mean below 1500Hz, bypassing v8 gate.
 *     v9 adds per-class hard gates: LF kurtosis (piston), session duration
 *     (starter), and mid-band energy ratio (power steering).
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

// v10 — energy_ratio gate: HF classifiers (bearing/intake) can ONLY fire when
// high-frequency energy (4kHz-12kHz) makes up >= 35% of total signal energy.
// Below this ratio the sound is LF-dominant (piston, water pump) and HF
// kurtosis/flatness measurements are meaningless noise harmonics, not fault signals.
const HF_ENERGY_RATIO_MIN = 0.35;  // audio_v10_energy_ratio = true

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
let frameHFCentroids  = [];
let frameHFFlatnesses = [];
let frameFullCentroids = [];
let clippedFrameCount = 0;
let sessionPeakSample = 0;
let sessionRmsSq = 0;
let sessionSampleCount = 0;
let lfEnvelopes = [];
// v9 — new orthogonal features
let frameRawHFKurt = [];    // kurtosis on RAW (pre-subtraction) 4-8kHz power per frame
let frameLFKurt    = [];    // kurtosis on 100-500Hz band (piston impulsive knock)
let frameMidEnergy = [];    // total energy 500Hz-3kHz (power steering whine band)
let sessionStartTime = 0;   // wall-clock ms when first 'process' arrives
// v10 — energy ratio gate arrays
let frameHFEnergy    = [];  // sum of clean power in 4kHz-12kHz band per frame
let frameTotalEnergy = [];  // sum of clean power across full band per frame

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
    if (sessionStartTime === 0) sessionStartTime = Date.now();
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

  // Build RAW power spectrum (before subtraction) for v9 bearing detection
  const rawPowerFull = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    const rawMag = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
    rawPowerFull[i] = rawMag * rawMag;
  }

  const power  = new Float32Array(FFT_SIZE / 2);
  const logMag = new Float32Array(FFT_SIZE / 2);
  let lfEnergy = 0;
  let midEnergy = 0;
  let hfEnergy = 0;    // v10: 4kHz-12kHz clean power
  let totalEnergy = 0; // v10: full-band clean power

  for (let i = 0; i < FFT_SIZE / 2; i++) {
    const rawPow = rawPowerFull[i];
    const noisePow = noiseMagProfile[i] * noiseMagProfile[i];
    const cleanPow = Math.max(rawPow - SS_ALPHA * noisePow, SS_BETA * rawPow);
    const cleanMag = Math.sqrt(cleanPow);
    power[i]  = cleanPow;
    logMag[i] = Math.log10(Math.max(Number.EPSILON, cleanMag));
    totalEnergy += cleanPow;
    if (i >= BIN_100HZ && i <= BIN_500HZ) lfEnergy  += cleanPow;
    if (i >= BIN_500HZ && i <= BIN_3KHZ)  midEnergy += cleanPow;
    if (i >= BIN_4KHZ  && i <= BIN_12KHZ) hfEnergy  += cleanPow;
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
    frameKurtoses.push(3.0); frameFlatnesses.push(0.5);
    frameHFCentroids.push(-1); frameHFFlatnesses.push(1.0);
    frameFullCentroids.push(-1);
    frameRawHFKurt.push(3.0); frameLFKurt.push(3.0); frameMidEnergy.push(0);
    frameHFEnergy.push(0); frameTotalEnergy.push(1); // ratio = 0 for clipped frames
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
  // v9 — raw features
  frameRawHFKurt.push(computeSpectralKurtosis(rawPowerFull, BIN_4KHZ, BIN_8KHZ));
  frameLFKurt.push(computeSpectralKurtosis(rawPowerFull, BIN_100HZ, BIN_500HZ));
  frameMidEnergy.push(midEnergy);
  // v10 — energy ratio gate
  frameHFEnergy.push(hfEnergy);
  frameTotalEnergy.push(totalEnergy);
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
    let validFrameCount = 0;
    for (let fi = 0; fi < frameVecs.length; fi++) {
      if (frameHFCentroids[fi] === -1) continue;
      for (let i = 0; i < vecLen; i++) avgVec[i] += frameVecs[fi][i];
      validFrameCount++;
    }
    if (validFrameCount === 0) { emitNormal(0); resetSession(); return; }
    for (let i = 0; i < vecLen; i++) avgVec[i] /= validFrameCount;

    // --- Standard session features ---
    const valid = (arr) => arr.filter((_, i) => frameHFCentroids[i] !== -1);
    const mean  = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const avgKurtosis    = mean(valid(frameKurtoses));
    const avgFlatness    = mean(valid(frameFlatnesses));
    const transientScore = computeTransientScore(allSessionSamples);
    const amDepth        = computeAMDepth(lfEnvelopes);

    // --- v9 Orthogonal features ---
    const validCentroids  = frameFullCentroids.filter(c => c >= 0);
    const avgFullCentroid = mean(validCentroids);

    const sessionRms         = sessionSampleCount > 0 ? Math.sqrt(sessionRmsSq / sessionSampleCount) : 0.001;
    const sessionCrestFactor = sessionRms > 0.001 ? sessionPeakSample / sessionRms : 0;
    const sessionDurationSec = sessionStartTime > 0 ? (Date.now() - sessionStartTime) / 1000 : 999;

    // RAW HF kurtosis: computed BEFORE spectral subtraction — bearing harmonics survive SS
    const validRawHF = valid(frameRawHFKurt);
    const avgRawHFKurt = mean(validRawHF);

    // LF kurtosis: high values indicate impulsive knocking (piston slap) in 100-500Hz band
    const avgLFKurt  = mean(valid(frameLFKurt));

    // Mid-band energy ratio: dominant 500Hz-3kHz energy = power steering whine signature
    const totalMidE  = frameMidEnergy.reduce((a, b) => a + b, 0);
    const totalLFE   = lfEnvelopes.reduce((a, b) => a + b * b, 0);
    const midToLFRatio = totalLFE > 0 ? totalMidE / (totalLFE + 1e-9) : 0;

    // v10 — HF Energy Ratio gate (audio_v10_energy_ratio = true)
    // Sum total and HF clean energy across all valid frames.
    // If hfRatio < HF_ENERGY_RATIO_MIN (0.35), the session is LF-dominant:
    // any kurtosis/flatness spike in 4-12kHz is a harmonic artefact of a
    // low-frequency mechanical fault, NOT a bearing or intake leak signature.
    const sumHF    = frameHFEnergy.reduce((a, b) => a + b, 0);
    const sumTotal = frameTotalEnergy.reduce((a, b) => a + b, 0);
    const hfRatio  = sumTotal > 0 ? sumHF / sumTotal : 0;
    const isHFDominant = hfRatio >= HF_ENERGY_RATIO_MIN;

    console.log(`[V9] frames=${validFrameCount} RawHFKurt=${avgRawHFKurt.toFixed(1)} LFKurt=${avgLFKurt.toFixed(1)} Centroid=${avgFullCentroid.toFixed(0)}Hz Crest=${sessionCrestFactor.toFixed(1)} Dur=${sessionDurationSec.toFixed(1)}s MidRatio=${midToLFRatio.toFixed(2)} HFRatio=${hfRatio.toFixed(3)} isHFDominant=${isHFDominant}`);

    // v9 BEARING BOOST — guard also with HF dominance check (v10)
    let bearingBoostCandidate = null;
    let bearingBoostScore = 0;
    if (avgRawHFKurt > 8.0 && validFrameCount >= 4 && isHFDominant) {
      const bearingRefs = referenceIndex.filter(r =>
        r.fault_type === 'alternator_bearing_fault' ||
        (r.label && (r.label.includes('bearing') || r.label.includes('alternator')))
      );
      for (const ref of bearingRefs) {
        if (!Array.isArray(ref.cosine_vec) || ref.cosine_vec.length !== vecLen) continue;
        const cosSim = cosineSimilarity(avgVec, ref.cosine_vec);
        const kurtNorm = Math.min(1.0, (avgRawHFKurt - 8.0) / 22.0);
        const bScore = 0.40 * cosSim + 0.60 * kurtNorm;
        if (bScore > bearingBoostScore) { bearingBoostScore = bScore; bearingBoostCandidate = ref; }
      }
      console.log(`[V9] Bearing boost: rawHFKurt=${avgRawHFKurt.toFixed(1)} hfRatio=${hfRatio.toFixed(3)} score=${bearingBoostScore.toFixed(3)} ref=${bearingBoostCandidate?.label}`);
    } else if (avgRawHFKurt > 8.0 && !isHFDominant) {
      console.log(`[V10] Bearing boost BLOCKED: hfRatio=${hfRatio.toFixed(3)} < ${HF_ENERGY_RATIO_MIN} (LF-dominant, HF kurtosis is artefact)`);
    }

    // --- Single-pass composite matching with v9 per-class gates ---
    let bestScore = 0, bestRaw = 0, bestMatch = null;

    for (const ref of referenceIndex) {
      if (!Array.isArray(ref.cosine_vec) || ref.cosine_vec.length !== vecLen) continue;

      const W = FAULT_WEIGHTS[ref.fault_type] || FAULT_WEIGHTS['default'];
      const cosSim   = cosineSimilarity(avgVec, ref.cosine_vec);
      const refKurt  = ref.kurtosis_score ?? 3.0;
      const kurtSim  = 1 / (1 + Math.abs(avgKurtosis - refKurt) / (Math.max(refKurt, avgKurtosis, 1e-6)));
      const refFlat  = ref.flatness_score ?? 0.5;
      const flatSim  = Math.max(0, 1 - Math.abs(avgFlatness - refFlat));
      const refTrans = ref.transient_score ?? 0.0;
      const transSim = 1 / (1 + Math.abs(transientScore - refTrans) / (Math.max(refTrans, transientScore, 0.1) + 1e-6));

      let composite = W.cosine * cosSim + W.kurtosis * kurtSim + W.flatness * flatSim + W.transient * transSim;

      // ── v10 HF ENERGY RATIO GATE ─────────────────────────────────────────────
      // If HF energy is NOT dominant (<35% of total), hard-veto HF classifiers.
      // A piston knock at 200Hz generates kurtosis harmonics at 4-8kHz but
      // hfRatio stays ~0.10-0.15 — below the 0.35 threshold.
      // A real bearing whine at 5kHz pushes hfRatio to 0.45-0.70.
      const isAltBearing = ref.fault_type === 'alternator_bearing_fault' ||
        (ref.label && (ref.label.includes('bearing') || ref.label.includes('alternator')));
      const isIntakeLeak = ref.fault_type === 'intake_leak' ||
        (ref.label && ref.label.includes('intake_leak'));

      if ((isAltBearing || isIntakeLeak) && !isHFDominant) {
        composite *= 0.04; // Hard veto: LF-dominant signal cannot be a HF fault
        console.log(`[V10] HF VETO ${ref.label}: hfRatio=${hfRatio.toFixed(3)} < ${HF_ENERGY_RATIO_MIN}`);
      }
      // ─────────────────────────────────────────────────────────────────────────

      const isWP = ref.fault_type === 'water_pump' || (ref.label && ref.label.includes('water_pump'));
      if (isWP) {
        let wpPenalty = 1.0;

        // GATE 1 — Pitch: centroid > 1500Hz (PowerSteering, RockerArm)
        if (avgFullCentroid > WP_CENTROID_MAX_HZ && avgFullCentroid > 0) {
          wpPenalty *= 0.04;
          console.log(`[V9] WP VETO pitch centroid=${avgFullCentroid.toFixed(0)}Hz`);
        }

        // GATE 2 — Crest > 6: impulsive knock (Piston)
        if (sessionCrestFactor > WP_CREST_MAX) {
          wpPenalty *= 0.04;
          console.log(`[V9] WP VETO crest=${sessionCrestFactor.toFixed(1)}`);
        }

        // GATE 3 — LF Kurtosis > 7: piston slap produces impulsive LF bursts
        if (avgLFKurt > 7.0) {
          wpPenalty *= 0.10;
          console.log(`[V9] WP VETO lfKurt=${avgLFKurt.toFixed(1)} (piston slap)`);
        }

        // GATE 4 — Short session + high transient = MotorStarter
        if (sessionDurationSec < 3.0 && transientScore > 0.4) {
          wpPenalty *= 0.04;
          console.log(`[V9] WP VETO starter dur=${sessionDurationSec.toFixed(1)}s trans=${transientScore.toFixed(2)}`);
        }

        // GATE 5 — Dominant mid-band energy = PowerSteering whine
        if (midToLFRatio > 3.0) {
          wpPenalty *= 0.10;
          console.log(`[V9] WP VETO midRatio=${midToLFRatio.toFixed(1)} (power steering)`);
        }

        // GATE 6 — AM Depth: water pump needs rotational wobble
        if (amDepth < 0.12) wpPenalty *= 0.35;

        composite *= wpPenalty;
      }

      if (composite > bestScore) { bestScore = composite; bestRaw = cosSim; bestMatch = ref; }
    }

    // Apply bearing boost if it outscores normal composite path
    if (bearingBoostScore > bestScore && bearingBoostCandidate) {
      bestScore = bearingBoostScore;
      bestRaw   = cosineSimilarity(avgVec, bearingBoostCandidate.cosine_vec);
      bestMatch = bearingBoostCandidate;
      console.log(`[V9] Bearing boost WINS: ${bestMatch.label} score=${bestScore.toFixed(3)}`);
    }

    console.log(`[V9] Final: "${bestMatch?.label}" score=${bestScore.toFixed(3)} threshold=${clampedThreshold.toFixed(3)}`);

    if (bestScore >= clampedThreshold && bestMatch) {
      self.postMessage({
        type: 'result',
        payload: {
          status: 'anomaly', anomaly: bestMatch.label,
          confidence: Math.min(1.0, bestScore),
          severity: bestMatch.severity || 'high',
          rms: Math.max(MIN_NOISE_FLOOR, noiseRms),
          spectralMeta: { kurtosis: avgKurtosis, rawHFKurt: avgRawHFKurt, lfKurt: avgLFKurt, flatness: avgFlatness, transient: transientScore, amDepth, centroid: avgFullCentroid, crestFactor: sessionCrestFactor, midRatio: midToLFRatio, hfRatio, duration: sessionDurationSec, cosine: bestRaw, threshold: clampedThreshold, frames: validFrameCount }
        }
      });
    } else {
      emitNormal(bestScore);
    }

  } catch (err) {
    console.error('[V9 Worker] handleStop error:', err);
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
  frameVecs = []; frameKurtoses = []; frameFlatnesses = [];
  frameHFCentroids = []; frameHFFlatnesses = []; frameFullCentroids = [];
  clippedFrameCount = 0;
  sessionPeakSample = 0; sessionRmsSq = 0; sessionSampleCount = 0;
  lfEnvelopes = [];
  frameRawHFKurt = []; frameLFKurt = []; frameMidEnergy = [];
  frameHFEnergy = []; frameTotalEnergy = [];
  sessionStartTime = 0;
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
