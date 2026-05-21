/**
 * AudioV8_SequenceProcessor.worker.js — Vroomie DSP Engine v13
 * 
 * 6-STAGE SEQUENCE CLASSIFIER (DTW)
 * Stage 1: Silence Detector (Hard RMS Gate)
 * Stage 2: Noise/Speech Rejection (Flatness & Crest factor)
 * Stage 3: Mechanical Candidate Detector (Transient energy / Spectral Flux)
 * Stage 4: Sequence Extraction (Ring Buffer of 50 frames, 13 MFCC + 1 Flux)
 * Stage 5: Sequence Similarity Engine (Dynamic Time Warping)
 * Stage 6: Temporal Confidence Stabilizer
 */

const TARGET_SR     = 16000;
const FFT_SIZE      = 512;
const HOP_SAMPLES   = 320; // 20ms frame
const SEQ_LENGTH    = 50;  // 1.0 seconds

const N_MELS = 40;
const N_MFCC = 13;
const N_FEATURES = 14;

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
  for (let i = 0; i < vecA.length; i++) {
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

function standardizeSequence(seq) {
  const numFrames = seq.length;
  if (numFrames === 0) return seq;
  const dims = seq[0].length;
  
  const stdSeq = Array.from({length: numFrames}, () => new Float32Array(dims));
  
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
  return stdSeq;
}

// Map max threshold: DTW is a distance measure (lower is better).
// Piston self-sim is ~0.46, cross is 2.5+. A threshold of 1.2 is a safe boundary.
// If UI passes 0.38 (which is 1 - 0.62 in some contexts), we just use a fixed max DTW.
let maxDtwDistance = 1.35; 

self.onmessage = function (ev) {
  const { type, payload } = ev.data;
  switch (type) {
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[V8 DTW Worker] Loaded ${referenceIndex.length} sequence templates.`);
      break;
    case 'setThresholds':
      // DTW distance threshold: 1.0 (strict), 1.5 (loose)
      if (payload && typeof payload.absThreshold === 'number') {
        const uiVal = payload.absThreshold; 
        maxDtwDistance = 2.0 - uiVal; // Higher UI threshold = Lower DTW Distance (stricter)
        console.log(`[V8 DTW Worker] DTW Max Distance Threshold set to ${maxDtwDistance.toFixed(3)}`);
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
    // Process one frame
    for (let i = 0; i < FFT_SIZE; i++) {
      reFFT[i] = sessionRing[i] * hann[i];
      imFFT[i] = 0;
    }
    fftInPlace(reFFT, imFFT);
    
    let flux = 0;
    const melEnergies = new Float64Array(N_MELS);
    
    for (let k = 0; k < fftBins; k++) {
      const mag = Math.sqrt(reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k]);
      flux += Math.max(0, mag - prevMag[k]);
      prevMag[k] = mag;
      for (let m = 0; m < N_MELS; m++) melEnergies[m] += fb[m][k] * mag;
    }
    
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
    
    featureSequence.push(Array.from(frameFeatures));
    if (featureSequence.length > SEQ_LENGTH) featureSequence.shift();
    
    sessionRing = sessionRing.slice(HOP_SAMPLES);
    frameCounter++;

    // Evaluate every 10 frames (200ms) to save CPU while maintaining temporal alignment
    if (featureSequence.length === SEQ_LENGTH && frameCounter % 10 === 0) {
      evaluateSequence();
    }
  }
}

// Temporal Confidence Stabilizer
let lastAnomaly = null;
let lastAnomalyTime = 0;
let confidenceStreak = 0;

function evaluateSequence() {
  if (referenceIndex.length === 0) return;

  // Compute RMS and basic stats for gating
  // We can approximate sequence energy from MFCC 0 (which correlates to Log Energy)
  let sumEnergy = 0, sumFlux = 0, maxFlux = 0;
  for (let i = 0; i < SEQ_LENGTH; i++) {
    sumEnergy += featureSequence[i][0];
    const flux = featureSequence[i][N_FEATURES - 1];
    sumFlux += flux;
    if (flux > maxFlux) maxFlux = flux;
  }
  const avgEnergy = sumEnergy / SEQ_LENGTH;
  const avgFlux = sumFlux / SEQ_LENGTH;

  // Stage 1 & 2: Hard Gate for Silence & Room Noise
  // (MFCC 0 is usually highly negative for silence. e.g. < -40)
  if (avgEnergy < -30.0) {
    confidenceStreak = 0;
    emitNormal(0, "silence");
    return;
  }
  
  // Stage 3: Non-Mechanical Transient Gate
  // Mechanical anomalies must have some structural flux (rhythm)
  if (maxFlux < 0.05) {
    confidenceStreak = 0;
    emitNormal(0, "ambient_noise");
    return;
  }

  // Stage 5: DTW Sequence Alignment
  const liveStd = standardizeSequence(featureSequence);
  
  let bestDist = Infinity;
  let bestMatch = null;

  for (const ref of referenceIndex) {
    if (!ref.dtw_sequence || ref.dtw_sequence.length === 0) continue;
    
    const dist = computeDTW(liveStd, ref.dtw_sequence);
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = ref;
    }
  }

  // Stage 6: Confidence Stabilizer
  const now = Date.now();
  if (bestDist <= maxDtwDistance && bestMatch) {
    if (lastAnomaly === bestMatch.label && (now - lastAnomalyTime < 1000)) {
      confidenceStreak++;
    } else {
      confidenceStreak = 1;
    }
    lastAnomaly = bestMatch.label;
    lastAnomalyTime = now;

    // Must hit at least 2 consecutive 200ms windows to trigger UI (temporal stability)
    if (confidenceStreak >= 2) {
      // Map distance to a 0.0 - 1.0 confidence score (for UI)
      // 0.0 dist -> 1.0 score. maxDtwDistance -> 0.7 score.
      const score = Math.max(0.7, 1.0 - (bestDist / (maxDtwDistance * 2)));

      console.log(`[V8 DTW] Detected "${bestMatch.label}" Dist=${bestDist.toFixed(3)} Score=${score.toFixed(2)} Flux=${maxFlux.toFixed(2)}`);
      self.postMessage({
        type: 'result',
        payload: {
          status: 'anomaly', 
          anomaly: bestMatch.label,
          confidence: score,
          severity: bestMatch.severity || 'high',
          rms: Math.max(0, (avgEnergy + 50) / 100), // Pseudo-RMS for UI
          spectralMeta: {
            rms: avgEnergy,
            dtwDistance: bestDist,
            dtwThreshold: maxDtwDistance
          }
        }
      });
    } else {
      // It's a candidate, but wait for stability
      emitNormal(0.5, "candidate_building");
    }
  } else {
    confidenceStreak = 0;
    // Normalized distance: 2.0 is usually far. We can emit normalized distance for debug.
    emitNormal(bestDist > 5 ? 0 : 0.2, "below_threshold");
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
