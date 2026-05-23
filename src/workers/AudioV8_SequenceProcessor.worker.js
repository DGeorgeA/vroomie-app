/**
 * AudioV8_SequenceProcessor.worker.js — Vroomie DSP Engine v14
 * 
 * 7-STAGE SEQUENCE CLASSIFIER (DTW + BMAD Gating)
 * Stage 1: True RMS Gate (Absolute Silence Rejection)
 * Stage 2: Spectral Flatness Gate (White Noise / Fan Rejection)
 * Stage 3: ZCR Gate (Speech / Hiss Rejection)
 * Stage 4: Mechanical Periodicity Detector (Transient rhythm isolation)
 * Stage 5: Sequence Extraction (Ring Buffer of 50 frames, 13 MFCC + 1 Flux)
 * Stage 6: Sequence Similarity Engine (Dynamic Time Warping)
 * Stage 7: Confidence Multiplier (BMAD Scoring)
 */

const TARGET_SR     = 16000;
const FFT_SIZE      = 512;
const HOP_SAMPLES   = 320; // 20ms frame
const SEQ_LENGTH    = 50;  // 1.0 seconds

const N_MELS = 40;
const N_MFCC = 13;
// Feature Dimensions: 13 MFCC + 1 Flux + 1 RMS + 1 Flatness + 1 ZCR = 17
const N_FEATURES = 17;

let referenceIndex = [];
let sessionRing = new Float32Array(0);

// Sequence Ring Buffer
const featureSequence = []; 
let frameCounter = 0;

let _cachedFB = null, _cachedFBsr = -1;
function getMelFilterbank(sr) {
  if (_cachedFB && _cachedFBsr === sr) return _cachedFB;
  const fftBins = FFT_SIZE / 2 + 1;
  const melMax = 2595 * Math.log10(1 + (sr / 2) / 700);
  const melPts = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) melPts[i] = i * melMax / (N_MELS + 1);
  const hzPts = new Float32Array(N_MELS + 2);
  const binPts = new Int32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    hzPts[i] = 700 * (Math.pow(10, melPts[i] / 2595) - 1);
    binPts[i] = Math.floor((FFT_SIZE + 1) * hzPts[i] / sr);
  }
  const fb = []; const bw = new Float32Array(N_MELS);
  for (let m = 0; m < N_MELS; m++) {
    const f = new Float32Array(fftBins);
    const lo = binPts[m], cen = binPts[m+1], hi = binPts[m+2];
    bw[m] = Math.max(1, hi - lo);
    for (let k = lo; k < cen && k < fftBins; k++) f[k] = cen > lo ? (k - lo) / (cen - lo) : 0;
    for (let k = cen; k <= hi && k < fftBins; k++) f[k] = hi > cen ? (hi - k) / (hi - cen) : 0;
    fb.push(f);
  }
  _cachedFB = { fb, bw }; _cachedFBsr = sr;
  return { fb, bw };
}

function getHannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (size - 1));
  return w;
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, wAngle = (2 * Math.PI) / len;
    const wRe = Math.cos(wAngle), wIm = Math.sin(wAngle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const tRe = curRe * re[i+j+half] - curIm * im[i+j+half];
        const tIm = curRe * im[i+j+half] + curIm * re[i+j+half];
        re[i+j+half] = re[i+j] - tRe; im[i+j+half] = im[i+j] - tIm;
        re[i+j] += tRe; im[i+j] += tIm;
        const nCurRe = curRe * wRe - curIm * wIm; curIm = curRe * wIm + curIm * wRe; curRe = nCurRe;
      }
    }
  }
}

function euclideanDistance(vecA, vecB) {
  let sum = 0;
  // Match on the first 14 dimensions (13 MFCC + 1 Flux) representing the template
  const dims = Math.min(vecA.length, vecB.length, 14);
  for (let i = 0; i < dims; i++) {
    const diff = vecA[i] - vecB[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function computeDTW(seqA, seqB) {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return Infinity;
  
  const dtw = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  dtw[0][0] = 0;
  
  const window = Math.max(Math.abs(n - m), Math.floor(Math.max(n, m) * 0.2));
  
  for (let i = 1; i <= n; i++) {
    const start = Math.max(1, i - window);
    const end = Math.min(m, i + window);
    for (let j = start; j <= end; j++) {
      const cost = euclideanDistance(seqA[i - 1], seqB[j - 1]);
      dtw[i][j] = cost + Math.min(
        dtw[i - 1][j],    // insertion
        dtw[i][j - 1],    // deletion
        dtw[i - 1][j - 1] // match
      );
    }
  }
  
  return dtw[n][m] / (n + m);
}

function standardizeSequence(seq, dimsToStandardize) {
  const numFrames = seq.length;
  if (numFrames === 0) return seq;
  const dims = dimsToStandardize; // Only standardize the MFCC+Flux dims (first 14)
  
  const stdSeq = Array.from({length: numFrames}, () => new Float32Array(seq[0].length));
  
  for (let d = 0; d < dims; d++) {
    let sum = 0, sumSq = 0;
    for (let f = 0; f < numFrames; f++) {
      sum += seq[f][d];
      sumSq += seq[f][d] * seq[f][d];
    }
    const mean = sum / numFrames;
    const std = Math.sqrt(Math.max(0, (sumSq / numFrames) - mean * mean)) || 1;
    for (let f = 0; f < numFrames; f++) {
      stdSeq[f][d] = (seq[f][d] - mean) / std;
    }
  }
  // Copy over the unstandardized extra features (RMS, Flatness, ZCR)
  for (let f = 0; f < numFrames; f++) {
    for (let d = dims; d < seq[f].length; d++) {
      stdSeq[f][d] = seq[f][d];
    }
  }
  return stdSeq;
}

let maxDtwDistance = 1.35; 

self.onmessage = function (ev) {
  const { type, payload } = ev.data;
  switch (type) {
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[V8 DTW Worker] Loaded ${referenceIndex.length} sequence templates.`);
      break;
    case 'setThresholds':
      if (payload && typeof payload.absThreshold === 'number') {
        const uiVal = payload.absThreshold; 
        maxDtwDistance = 2.0 - uiVal; 
      }
      break;
    case 'process': handleProcess(payload); break;
    case 'stop':    handleStop();           break;
  }
};

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

let prevMag = new Float32Array(FFT_SIZE / 2 + 1);
let noiseFloor = 0.005;

function handleProcess({ buffer, sampleRate }) {
  try {
    const pcm = sampleRate === TARGET_SR ? buffer : linearResample(buffer, sampleRate, TARGET_SR);
    
    const ring2 = new Float32Array(sessionRing.length + pcm.length);
    ring2.set(sessionRing);
    ring2.set(pcm, sessionRing.length);
    sessionRing = ring2;

    processFrames();
  } catch (err) {
    console.error('[V8 DTW Worker] process error:', err);
  }
}

function processFrames() {
  const { fb, bw } = getMelFilterbank(TARGET_SR);
  const hann = getHannWindow(FFT_SIZE);
  const fftBins = FFT_SIZE / 2 + 1;
  const reFFT = new Float32Array(FFT_SIZE), imFFT = new Float32Array(FFT_SIZE);
  
  while (sessionRing.length >= FFT_SIZE) {
    
    let frameEnergySq = 0;
    let zcr = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = sessionRing[i];
      frameEnergySq += s * s;
      reFFT[i] = s * hann[i];
      imFFT[i] = 0;
      if (i > 0 && ((s >= 0) !== (sessionRing[i-1] >= 0))) zcr++;
    }
    const rms = Math.sqrt(frameEnergySq / FFT_SIZE);
    
    // Live Mic Dynamic Calibration: Trailing Noise Floor
    if (rms < noiseFloor) noiseFloor = 0.95 * noiseFloor + 0.05 * rms;
    else noiseFloor = 0.995 * noiseFloor + 0.005 * rms;
    
    // Bounds for safety
    if (noiseFloor < 0.001) noiseFloor = 0.001;
    if (noiseFloor > 0.05) noiseFloor = 0.05;

    const zcrNorm = zcr / FFT_SIZE;

    fftInPlace(reFFT, imFFT);
    
    let flux = 0;
    let gmLog = 0, amSum = 0;
    const melEnergies = new Float64Array(N_MELS);
    
    for (let k = 0; k < fftBins; k++) {
      const mag = Math.sqrt(reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k]);
      flux += Math.max(0, mag - prevMag[k]);
      prevMag[k] = mag;
      
      if (k > 0) { // Skip DC for flatness
        gmLog += Math.log(mag + 1e-10);
        amSum += mag;
      }

      for (let m = 0; m < N_MELS; m++) melEnergies[m] += fb[m][k] * mag;
    }
    
    const gm = Math.exp(gmLog / (fftBins - 1));
    const am = (amSum / (fftBins - 1)) + 1e-10;
    const flatness = gm / am;
    
    for (let m = 0; m < N_MELS; m++) melEnergies[m] = Math.log(Math.max(melEnergies[m] / bw[m], 1e-10));
    
    const mfcc = new Float64Array(N_MFCC);
    for (let k = 0; k < N_MFCC; k++) {
      let sum = 0;
      for (let m = 0; m < N_MELS; m++) sum += melEnergies[m] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
      mfcc[k] = sum;
    }
    
    const frameFeatures = new Float32Array(N_FEATURES);
    frameFeatures.set(mfcc, 0);
    frameFeatures[N_MFCC] = Math.log10(1 + flux);
    frameFeatures[14] = rms;
    frameFeatures[15] = flatness;
    frameFeatures[16] = zcrNorm;
    
    featureSequence.push(Array.from(frameFeatures));
    if (featureSequence.length > SEQ_LENGTH) featureSequence.shift();
    
    sessionRing = sessionRing.slice(HOP_SAMPLES);
    frameCounter++;

    if (featureSequence.length === SEQ_LENGTH && frameCounter % 10 === 0) {
      evaluateSequence();
    }
  }
}

let lastAnomaly = null;
let lastAnomalyTime = 0;
let confidenceStreak = 0;

function evaluateSequence() {
  if (referenceIndex.length === 0) return;

  // BMAD Gating Layer — Mechanical Sound Qualifier
  let maxRMS = 0;
  let sumFlatness = 0;
  let sumZcr = 0;
  let maxFlux = 0;

  for (let i = 0; i < SEQ_LENGTH; i++) {
    const frame = featureSequence[i];
    const flux = frame[13];
    const rms = frame[14];
    const flatness = frame[15];
    const zcr = frame[16];

    if (rms > maxRMS) maxRMS = rms;
    if (flux > maxFlux) maxFlux = flux;
    sumFlatness += flatness;
    sumZcr += zcr;
  }
  
  const avgFlatness = sumFlatness / SEQ_LENGTH;
  const avgZcr = sumZcr / SEQ_LENGTH;

  // GATE 1: Dynamic RMS Gate (Live Mic Calibration)
  // Must be significantly above the calibrated environmental noise floor
  if (maxRMS < Math.max(0.005, noiseFloor * 2.5)) { 
    confidenceStreak = 0;
    emitNormal(0, `silence_or_floor_${noiseFloor.toFixed(4)}`);
    return;
  }

  // GATE 2: Spectral Flatness (Reject fan noise, wind, microphone static/hiss)
  // White noise approaches 1.0. Tonal engine noise is < 0.5.
  if (avgFlatness > 0.6) {
    confidenceStreak = 0;
    emitNormal(0, "room_noise_or_fan");
    return;
  }

  // GATE 3: ZCR Gate (Reject speech and high-frequency erratic hiss)
  // High ZCR usually implies unvoiced speech (sibilance) or static.
  if (avgZcr > 0.4) {
    confidenceStreak = 0;
    emitNormal(0, "speech_or_static");
    return;
  }

  // GATE 4: Transient Periodicity
  // A mechanical fault MUST have some physical percussive signature
  if (maxFlux < 0.05) {
    confidenceStreak = 0;
    emitNormal(0, "non_mechanical");
    return;
  }

  // PASSED ALL GATES -> Execute DTW Sequence Alignment
  // Standardize only the MFCC + Flux dimensions (14) for Euclidean distance
  const liveStd = standardizeSequence(featureSequence, 14);
  
  const results = [];
  for (const ref of referenceIndex) {
    if (!ref.dtw_sequence || ref.dtw_sequence.length === 0) continue;
    
    const dist = computeDTW(liveStd, ref.dtw_sequence);
    results.push({ ref, dist });
  }

  results.sort((a, b) => a.dist - b.dist);

  if (results.length === 0) return;

  const bestMatch = results[0].ref;
  const bestDist = results[0].dist;
  const secondBestDist = results.length > 1 ? results[1].dist : Infinity;

  // PART 3: TOP-2 DIFFERENCE VALIDATION
  // True anomalies have a massive separation margin (e.g. 2.0+). 
  // Noise collapses with small margins (e.g. 0.1).
  const separationMargin = secondBestDist - bestDist;
  if (results.length > 1 && separationMargin < 0.25) {
    confidenceStreak = 0;
    emitNormal(0, `ambiguous_collapse_margin_${separationMargin.toFixed(2)}`);
    return;
  }

  // GATE 5: DTW Minimum Alignment Confidence
  const now = Date.now();
  if (bestDist <= maxDtwDistance && bestMatch) {
    
    if (lastAnomaly === bestMatch.label && (now - lastAnomalyTime < 1000)) {
      confidenceStreak++;
    } else {
      confidenceStreak = 1;
    }
    lastAnomaly = bestMatch.label;
    lastAnomalyTime = now;

    if (confidenceStreak >= 2) {
      // Final Admission Confidence Score (BMAD formula)
      // Combines: DTW Quality, Mechanical Periodicity (1-Flatness), and Separation Margin
      const dtwScore = Math.max(0.0, 1.0 - (bestDist / maxDtwDistance));
      const mechScore = Math.max(0.0, 1.0 - avgFlatness);
      const marginBonus = Math.min(1.0, separationMargin / 2.0); // Reward high separation
      
      const finalConfidence = dtwScore * mechScore * marginBonus;
      
      // Strict floor: finalConfidence must be > 0.3
      if (finalConfidence < 0.3) {
         emitNormal(finalConfidence, "low_confidence_match");
         return;
      }

      console.log(`[V8 DTW] Detected "${bestMatch.label}" Dist=${bestDist.toFixed(3)} Margin=${separationMargin.toFixed(2)} Score=${finalConfidence.toFixed(2)}`);
      self.postMessage({
        type: 'result',
        payload: {
          status: 'anomaly', 
          anomaly: bestMatch.label,
          confidence: Math.min(1.0, Math.max(0.75, finalConfidence + 0.4)), // Boost for UI visual threshold
          severity: bestMatch.severity || 'high',
          rms: Math.max(0, (maxRMS * 50)), // Pseudo-RMS for UI waveform
          spectralMeta: {
            rms: maxRMS,
            dtwDistance: bestDist,
            flatness: avgFlatness,
            margin: separationMargin
          }
        }
      });
    } else {
      emitNormal(0.5, "candidate_building");
    }
  } else {
    confidenceStreak = 0;
    emitNormal(0.1, "no_dtw_alignment");
  }
}

function handleStop() {
  processFrames();
  resetSession();
}

function emitNormal(confidence, reason) {
  self.postMessage({ type: 'result', payload: { status: 'normal', anomaly: null, confidence, rms: 0, reason } });
}

function resetSession() {
  sessionRing = new Float32Array(0);
  featureSequence.length = 0;
  frameCounter = 0;
  confidenceStreak = 0;
}
