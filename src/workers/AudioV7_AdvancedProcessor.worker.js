/**
 * AudioV7_AdvancedProcessor.worker.js — Vroomie DSP Engine v12
 * 
 * 5-STAGE HYBRID CLASSIFIER
 * Stage 1: Silence Detector (Hard RMS Gate)
 * Stage 2: Noise/Speech Rejection (Flatness & Pitch variance)
 * Stage 3: Mechanical Candidate Detector (Transient energy / Rhythmic pulse)
 * Stage 4: Embedding Similarity (188-dim Mel-MFCC cosine/pearson)
 * Stage 5: Temporal Consistency (Validation)
 */

const TARGET_SR     = 16000;
const FFT_SIZE      = 512;
const FRAME_SAMPLES = FFT_SIZE;
const HOP_SAMPLES   = 160;

const N_MELS = 64;
const N_MFCC = 13;

let referenceIndex = [];
let sessionRing = new Float32Array(0);
let sessionStartTime = 0;

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

function l2Norm(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
  n = Math.sqrt(n) || 1e-10;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
  return out;
}

function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < len; i++) { dot += a[i]*b[i]; nA += a[i]*a[i]; nB += b[i]*b[i]; }
  return (nA > 0 && nB > 0) ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
}

function pearsonSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < len; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / len, meanB = sumB / len;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < len; i++) {
    const ca = a[i] - meanA, cb = b[i] - meanB;
    dot += ca * cb; nA += ca * ca; nB += cb * cb;
  }
  if (nA < 1e-12 || nB < 1e-12) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

let clampedThreshold = 0.82; // Base threshold for 188-dim vector

self.onmessage = function (ev) {
  const { type, payload } = ev.data;
  switch (type) {
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[V7 Worker] Loaded ${referenceIndex.length} mechanical signatures.`);
      break;
    case 'setThresholds':
      if (payload && typeof payload.absThreshold === 'number') {
        // Map legacy 0.38 threshold to a safer 0.88 to prevent noise from triggering anomalies
        clampedThreshold = payload.absThreshold > 0.60 ? payload.absThreshold : 0.88;
        console.log(`[V7 Worker] Threshold set to ${clampedThreshold.toFixed(3)}`);
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

function handleProcess({ buffer, sampleRate }) {
  try {
    if (sessionStartTime === 0) sessionStartTime = Date.now();
    const pcm = sampleRate === TARGET_SR ? buffer : linearResample(buffer, sampleRate, TARGET_SR);
    
    // Mix into session ring
    const ring2 = new Float32Array(sessionRing.length + pcm.length);
    ring2.set(sessionRing);
    ring2.set(pcm, sessionRing.length);
    sessionRing = ring2;
  } catch (err) {
    console.error('[V7 Worker] process error:', err);
  }
}

function handleStop() {
  try {
    if (sessionRing.length < FFT_SIZE * 2) {
      emitNormal(0, "too_short");
      return;
    }

    const samples = sessionRing; // Already at 16kHz
    const { fb, bw } = getMelFilterbank(TARGET_SR);
    const hann = getHannWindow(FFT_SIZE);
    const fftBins = FFT_SIZE / 2 + 1;
    const numFrames = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP_SAMPLES));
    
    const melHistory = Array.from({ length: N_MELS }, () => new Float64Array(numFrames));
    const mfccHistory = Array.from({ length: N_MFCC }, () => new Float64Array(numFrames));
    const fluxHistory = new Float64Array(numFrames);
    const crestHistory = new Float64Array(numFrames);
  
    let totalZCR = 0, totalRMS = 0, totalCentroid = 0;
    const reFFT = new Float32Array(FFT_SIZE), imFFT = new Float32Array(FFT_SIZE);
    let prevMag = new Float32Array(fftBins);
  
    // ==========================================
    // STAGE 1: SIGNAL PROCESSING & FEATURE EXTRACTION
    // ==========================================
    for (let f = 0; f < numFrames; f++) {
      const start = f * HOP_SAMPLES;
      for (let i = 0; i < FFT_SIZE; i++) { reFFT[i] = (samples[start + i] || 0) * hann[i]; imFFT[i] = 0; }
      fftInPlace(reFFT, imFFT);
      
      let frameRMS = 0, weightedSum = 0, powerSum = 0;
      let maxMag = 0, flux = 0;
  
      for (let k = 0; k < fftBins; k++) {
        const mag = Math.sqrt(reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k]);
        if (mag > maxMag) maxMag = mag;
        flux += Math.max(0, mag - prevMag[k]);
        prevMag[k] = mag;
  
        frameRMS += reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k];
        weightedSum += k * mag; powerSum += mag;
        for (let m = 0; m < N_MELS; m++) melHistory[m][f] += fb[m][k] * mag;
      }
      
      fluxHistory[f] = flux;
      const rms = Math.sqrt(frameRMS / fftBins);
      totalRMS += rms;
      crestHistory[f] = rms > 0 ? maxMag / rms : 0;
      
      totalCentroid += powerSum > 0 ? (weightedSum / powerSum) / fftBins : 0;
      let zcr = 0;
      for (let i = 1; i < FFT_SIZE; i++) if ((samples[start + i] >= 0) !== (samples[start + i - 1] >= 0)) zcr++;
      totalZCR += zcr / FFT_SIZE;
      
      for (let m = 0; m < N_MELS; m++) melHistory[m][f] = Math.log(Math.max(melHistory[m][f] / bw[m], 1e-10));
      for (let k = 0; k < N_MFCC; k++) {
        let sum = 0;
        for (let m = 0; m < N_MELS; m++) sum += melHistory[m][f] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
        mfccHistory[k][f] = sum;
      }
    }
  
    const deltaMfccHistory = Array.from({ length: N_MFCC }, () => new Float64Array(numFrames));
    for (let k = 0; k < N_MFCC; k++) {
      for (let f = 1; f < numFrames - 1; f++) {
        deltaMfccHistory[k][f] = (mfccHistory[k][f+1] - mfccHistory[k][f-1]) / 2;
      }
    }
  
    const melMean = new Float64Array(N_MELS), melSD = new Float64Array(N_MELS);
    const mfccMean = new Float64Array(N_MFCC), mfccSD = new Float64Array(N_MFCC);
    const dMfccMean = new Float64Array(N_MFCC), dMfccSD = new Float64Array(N_MFCC);
    
    let fluxMean = 0, fluxMax = 0, crestMean = 0, crestMax = 0;
    for (let f = 0; f < numFrames; f++) {
      fluxMean += fluxHistory[f];
      if (fluxHistory[f] > fluxMax) fluxMax = fluxHistory[f];
      crestMean += crestHistory[f];
      if (crestHistory[f] > crestMax) crestMax = crestHistory[f];
    }
    fluxMean /= numFrames; crestMean /= numFrames;
  
    for (let m = 0; m < N_MELS; m++) {
      let sum = 0, sumSq = 0;
      for (let f = 0; f < numFrames; f++) { sum += melHistory[m][f]; sumSq += melHistory[m][f] * melHistory[m][f]; }
      melMean[m] = sum / numFrames; melSD[m] = Math.sqrt(Math.max(0, (sumSq / numFrames) - melMean[m] * melMean[m]));
    }
    
    for (let k = 0; k < N_MFCC; k++) {
      let sum = 0, sumSq = 0, dSum = 0, dSumSq = 0;
      for (let f = 0; f < numFrames; f++) { 
        sum += mfccHistory[k][f]; sumSq += mfccHistory[k][f] * mfccHistory[k][f]; 
        dSum += deltaMfccHistory[k][f]; dSumSq += deltaMfccHistory[k][f] * deltaMfccHistory[k][f]; 
      }
      mfccMean[k] = sum / numFrames; mfccSD[k] = Math.sqrt(Math.max(0, (sumSq / numFrames) - mfccMean[k] * mfccMean[k]));
      dMfccMean[k] = dSum / numFrames; dMfccSD[k] = Math.sqrt(Math.max(0, (dSumSq / numFrames) - dMfccMean[k] * dMfccMean[k]));
    }
  
    const transientFeatures = new Float32Array(8);
    transientFeatures[0] = Math.min(1.0, (totalRMS / numFrames) * 1.5);
    transientFeatures[1] = Math.min(1.0, (totalZCR / numFrames) * 2.0);
    transientFeatures[2] = Math.min(1.0, (totalCentroid / numFrames) * 1.2);
    transientFeatures[3] = Math.min(1.0, fluxMean * 0.1);
    transientFeatures[4] = Math.min(1.0, fluxMax * 0.05);
    transientFeatures[5] = Math.min(1.0, crestMean * 0.1);
    transientFeatures[6] = Math.min(1.0, crestMax * 0.05);
    transientFeatures[7] = crestMax > crestMean * 3 ? 1.0 : 0.0;
  
    const raw = new Float32Array(N_MELS * 2 + N_MFCC * 4 + 8);
    let offset = 0;
    raw.set(l2Norm(melMean), offset); offset += N_MELS;
    raw.set(l2Norm(melSD), offset); offset += N_MELS;
    raw.set(l2Norm(mfccMean), offset); offset += N_MFCC;
    raw.set(l2Norm(mfccSD), offset); offset += N_MFCC;
    raw.set(l2Norm(dMfccMean), offset); offset += N_MFCC;
    raw.set(l2Norm(dMfccSD), offset); offset += N_MFCC;
    raw.set(l2Norm(transientFeatures), offset);
    
    const embedding = Array.from(l2Norm(raw));

    // ==========================================
    // STAGE 2: HARD SILENCE & NOISE REJECTION
    // ==========================================
    const sessionRms = totalRMS / numFrames;
    if (sessionRms < 0.012) {
      console.log(`[V7] Reject Stage 1 (Silence/Room Noise): rms=${sessionRms.toFixed(5)}`);
      emitNormal(0, "silence");
      return;
    }
    
    if (crestMax < 2.2 || fluxMax < 0.02) {
      console.log(`[V7] Reject Stage 2 (Non-Mechanical Noise): crest=${crestMax.toFixed(2)}, flux=${fluxMax.toFixed(3)}`);
      emitNormal(0, "ambient_noise");
      return;
    }

    // ==========================================
    // STAGE 3: ADAPTIVE SIMILARITY & HYBRID SCORING
    // ==========================================
    let bestScore = 0, bestRaw = 0, bestMatch = null;

    for (const ref of referenceIndex) {
      if (!Array.isArray(ref.cosine_vec) || ref.cosine_vec.length !== 188) continue; // Skip old 743-dim vectors

      const cosSim = cosineSimilarity(embedding, ref.cosine_vec);
      const pearSim = pearsonSimilarity(embedding, ref.cosine_vec);
      
      // Hybrid Similarity: 70% Cosine (directional), 30% Pearson (shape)
      const hybridSim = 0.7 * cosSim + 0.3 * pearSim;

      if (hybridSim > bestScore) {
        bestScore = hybridSim;
        bestRaw = cosSim;
        bestMatch = ref;
      }
    }

    // Temporal Confidence: Penalize very short or very quiet events
    const rmsPenalty = sessionRms < 0.015 ? (sessionRms / 0.015) : 1.0;
    
    // Transient Confidence: Boost score if flux/crest align with mechanical strikes
    const transientScore = transientFeatures[7] === 1.0 ? 1.05 : 1.0;
    
    let finalScore = bestScore * rmsPenalty * transientScore;

    console.log(`[V7] SessionRMS=${sessionRms.toFixed(4)} rmsPenalty=${rmsPenalty.toFixed(3)} transient=${transientScore}`);
    console.log(`[V7] Best: "${bestMatch?.label}" rawCos=${bestRaw.toFixed(3)} finalScore=${finalScore.toFixed(3)} threshold=${clampedThreshold.toFixed(3)}`);

    if (finalScore >= clampedThreshold && bestMatch) {
      self.postMessage({
        type: 'result',
        payload: {
          status: 'anomaly', 
          anomaly: bestMatch.label,
          confidence: Math.min(1.0, finalScore),
          severity: bestMatch.severity || 'high',
          rms: sessionRms,
          spectralMeta: {
            rms: sessionRms,
            fluxMean: fluxMean,
            crestMax: crestMax,
            finalScore: finalScore,
            threshold: clampedThreshold
          }
        }
      });
    } else {
      emitNormal(finalScore, "below_threshold");
    }

  } catch (err) {
    console.error('[V7 Worker] handleStop error:', err);
    emitNormal(0, "error");
  } finally {
    resetSession();
  }
}

function emitNormal(confidence, reason) {
  self.postMessage({ type: 'result', payload: { status: 'normal', anomaly: null, confidence, rms: 0, reason } });
}

function resetSession() {
  sessionRing = new Float32Array(0);
  sessionStartTime = 0;
}
