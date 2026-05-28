/**
 * AudioV8_SequenceProcessor.worker.js — Vroomie DSP Engine v15
 * 
 * 8-STAGE AUDIO DOMAIN CLASSIFIER + DTW ANOMALY ENGINE
 *
 * STAGE 1: RMS Silence Gate (dynamic noise floor)
 * STAGE 2: Audio Domain Classifier — Speech/Music/TV Detector
 *          Uses TEMPORAL DYNAMICS of MFCC, ZCR, Flatness, and RMS
 *          to distinguish human audio (speech, music, TV) from engine audio.
 *          Speech changes spectrally every 50-200ms (syllables).
 *          Engine sounds are spectrally STATIONARY at a given RPM.
 * STAGE 3: Spectral Flatness Gate (broadband noise)
 * STAGE 4: Mechanical Periodicity Gate (transient flux)
 * STAGE 5: DTW Sequence Alignment
 * STAGE 6: Top-2 Class Separation Margin
 * STAGE 7: BMAD Composite Confidence
 * STAGE 8: Temporal Consistency Stabilizer
 */

// TARGET_SR declared below after imports
import * as tf from '@tensorflow/tfjs';
import { YAMNET_CLASSES } from '../data/yamnet_classes.js';

let yamnetModel = null;
tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true })
  .then(model => {
    yamnetModel = model;
    console.log('[V8 Worker] YAMNet loaded successfully.');
    // Warmup
    const dummy = tf.zeros([15600]);
    model.predict(dummy).dispose();
    dummy.dispose();
  })
  .catch(err => console.error('[V8 Worker] YAMNet load failed:', err));

const TARGET_SR = 16000;
const FFT_SIZE = 512;
const HOP = 320;
const N_MELS = 40;
const N_MFCC = 13;
const SEQ_LENGTH = 50;
// Per-frame features: 13 MFCC + 1 Flux + 1 RMS + 1 Flatness + 1 ZCR + 1 SpectralCentroid = 18
const N_FEATURES = 18;

let referenceIndex = [];
let sessionRing = new Float32Array(0);
let yamnetRing = new Float32Array(0); // 15600 samples for YAMNet

const featureSequence = []; 
let frameCounter = 0;

// ── Mel Filterbank ──────────────────────────────────────────
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

// ── FFT ─────────────────────────────────────────────────────
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

// ── DTW Engine ──────────────────────────────────────────────
function euclideanDistance(vecA, vecB) {
  let sum = 0;
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
  // CRITICAL FIX: Constrain DTW warping window to max 2 frames (40ms).
  // Previously this was 20% (10 frames = 200ms), which allowed DTW to stretch 
  // a single phoneme of human speech to match an entire 1-second engine sequence!
  // Mechanical engines are highly rhythmic and require strict temporal alignment.
  const window = Math.max(Math.abs(n - m), 2);
  
  for (let i = 1; i <= n; i++) {
    const start = Math.max(1, i - window);
    const end = Math.min(m, i + window);
    for (let j = start; j <= end; j++) {
      const cost = euclideanDistance(seqA[i - 1], seqB[j - 1]);
      dtw[i][j] = cost + Math.min(
        dtw[i - 1][j],
        dtw[i][j - 1],
        dtw[i - 1][j - 1]
      );
    }
  }
  
  return dtw[n][m] / (n + m);
}

function standardizeSequence(seq, dimsToStandardize) {
  const numFrames = seq.length;
  if (numFrames === 0) return seq;
  const dims = dimsToStandardize;
  
  const stdSeq = Array.from({length: numFrames}, () => new Float32Array(seq[0].length));
  
  for (let d = 0; d < dims; d++) {
    let sum = 0, sumSq = 0;
    for (let f = 0; f < numFrames; f++) {
      sum += seq[f][d];
      sumSq += seq[f][d] * seq[f][d];
    }
    const mean = sum / numFrames;
    const std = Math.max(1e-5, Math.sqrt(Math.max(0, (sumSq / numFrames) - mean * mean)));
    for (let f = 0; f < numFrames; f++) {
      stdSeq[f][d] = (seq[f][d] - mean) / std;
    }
  }
  for (let f = 0; f < numFrames; f++) {
    for (let d = dims; d < seq[f].length; d++) {
      stdSeq[f][d] = seq[f][d];
    }
  }
  return stdSeq;
}

// ══════════════════════════════════════════════════════════════
// AUDIO DOMAIN CLASSIFIER — Speech/Music/TV Detector
// ══════════════════════════════════════════════════════════════
//
// The key insight: Speech and music CHANGE their spectral shape
// rapidly (every 50-200ms for syllables/notes). Engine sounds are
// spectrally STATIONARY at a given RPM — their MFCC trajectory
// is nearly flat over time.
//
// We measure the TEMPORAL VARIANCE of multiple features across
// the 50-frame (1-second) window. High variance = human audio.
// Low variance = steady mechanical/engine audio.
//
// Features analyzed:
//   1. MFCC temporal variance (speech shifts vowels/consonants)
//   2. RMS modulation index (speech has syllabic amplitude envelope)
//   3. ZCR temporal variance (speech alternates voiced/unvoiced)
//   4. Spectral centroid variance (speech formants shift)
//   5. Flatness temporal variance (speech: tonal↔noisy alternation)
//
// Each produces a "human audio score". If the combined score
// exceeds a threshold, the signal is classified as speech/music/TV
// and REJECTED before DTW ever executes.
// ══════════════════════════════════════════════════════════════

function computeTemporalVariance(seq, featureIdx) {
  let sum = 0, sumSq = 0;
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i][featureIdx];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / seq.length;
  return (sumSq / seq.length) - (mean * mean);
}

function computeCoeffOfVariation(seq, featureIdx) {
  let sum = 0, sumSq = 0;
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i][featureIdx];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / seq.length;
  const variance = (sumSq / seq.length) - (mean * mean);
  const std = Math.sqrt(Math.max(0, variance));
  return (Math.abs(mean) > 1e-8) ? (std / Math.abs(mean)) : std;
}

function classifyAudioDomain(seq) {
  // 1. MFCC temporal dynamics: compute variance of MFCCs 1-12 across time
  //    (Skip MFCC 0 which is just energy level)
  //    Speech has VERY high MFCC variance (changing phonemes).
  //    Engine sounds have LOW MFCC variance (stationary spectrum).
  let mfccVarSum = 0;
  for (let c = 1; c < N_MFCC; c++) {
    mfccVarSum += computeTemporalVariance(seq, c);
  }
  const avgMfccVar = mfccVarSum / (N_MFCC - 1);
  
  // 2. RMS modulation index (coefficient of variation of RMS)
  //    Speech has high modulation (~0.3-0.8) due to syllables/pauses.
  //    Engine sounds have low modulation (~0.05-0.15).
  const rmsCV = computeCoeffOfVariation(seq, 14); // RMS at index 14
  
  // 3. ZCR temporal variance
  //    Speech alternates between voiced (low ZCR) and unvoiced (high ZCR).
  //    Engine sounds have more consistent ZCR.
  const zcrVar = computeTemporalVariance(seq, 16); // ZCR at index 16
  
  // 4. Spectral centroid variance  
  //    Speech formants shift → centroid moves.
  //    Engine has stable centroid.
  const centroidVar = computeTemporalVariance(seq, 17); // Centroid at index 17
  
  // 5. Flatness temporal variance
  //    Speech alternates tonal vowels (low flatness) and noisy consonants (high flatness).
  //    Engine has more consistent flatness.
  const flatnessVar = computeTemporalVariance(seq, 15); // Flatness at index 15

  // 6. RMS zero-run detection: count frames where RMS drops to near-silence
  //    Speech has natural pauses between words/sentences.
  //    Engine sounds are continuous.
  let silentFrames = 0;
  let sumRms = 0;
  for (let i = 0; i < seq.length; i++) {
    sumRms += seq[i][14];
    if (seq[i][14] < 0.005) silentFrames++;
  }
  const avgRms = sumRms / seq.length;
  const silenceRatio = silentFrames / seq.length;

  // ── Scoring ──
  // Each feature contributes a normalized [0,1] score indicating "human-ness".
  // These are empirically calibrated.
  
  // MFCC variance: engine < 5, speech > 20 typically
  const mfccScore = Math.min(1.0, avgMfccVar / 30.0);
  
  // RMS CV: engine < 0.2, speech > 0.4 typically
  const rmsScore = Math.min(1.0, rmsCV / 0.8);
  
  // ZCR variance: engine < 0.002, speech > 0.005
  const zcrScore = Math.min(1.0, zcrVar / 0.01);
  
  // Centroid variance: engine < 0.001, speech > 0.005  
  const centroidScore = Math.min(1.0, centroidVar / 0.01);
  
  // Flatness variance: engine < 0.002, speech > 0.005
  const flatnessScore = Math.min(1.0, flatnessVar / 0.01);

  // Silence ratio: engine ~0, speech > 0.1 
  const pauseScore = Math.min(1.0, silenceRatio / 0.3);

  // Weighted combination — MFCC variance and RMS modulation are the strongest discriminators
  const humanAudioScore = 
    0.30 * mfccScore +
    0.25 * rmsScore +
    0.15 * zcrScore +
    0.10 * centroidScore +
    0.10 * flatnessScore +
    0.10 * pauseScore;

  return {
    humanAudioScore,
    mfccScore,
    rmsScore,
    zcrScore,
    centroidScore,
    flatnessScore,
    pauseScore,
    debug: { avgMfccVar, rmsCV, zcrVar, centroidVar, flatnessVar, silenceRatio }
  };
}

// ── Config ──────────────────────────────────────────────────
// With V15-aligned references, self-similarity is ~0.0 and cross-class is ~2.0+.
// maxDtwDistance 0.8 gives generous margin for speaker→mic degradation.
let maxDtwDistance = 0.80; 

self.onmessage = function (ev) {
  const { type, payload } = ev.data;
  switch (type) {
    case 'setReferenceIndex':
      referenceIndex = payload || [];
      console.log(`[V8 DTW Worker] Loaded ${referenceIndex.length} sequence templates.`);
      break;
    case 'setThresholds':
      // LOCKED: maxDtwDistance is hard-coded at 0.80. Frontend overrides are ignored.
      // The previous override to 1.35 was the secondary cause of false positives.
      break;
    case '_legacy_setThresholds': // dead code, kept for reference
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

    const yRing2 = new Float32Array(yamnetRing.length + pcm.length);
    yRing2.set(yamnetRing);
    yRing2.set(pcm, yamnetRing.length);
    if (yRing2.length > 15600) {
      yamnetRing = yRing2.slice(yRing2.length - 15600);
    } else {
      yamnetRing = yRing2;
    }

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
    
    // Dynamic noise floor tracking
    if (rms < noiseFloor) noiseFloor = 0.95 * noiseFloor + 0.05 * rms;
    else noiseFloor = 0.995 * noiseFloor + 0.005 * rms;
    if (noiseFloor < 0.001) noiseFloor = 0.001;
    if (noiseFloor > 0.05) noiseFloor = 0.05;

    const zcrNorm = zcr / FFT_SIZE;

    fftInPlace(reFFT, imFFT);
    
    let flux = 0;
    let gmLog = 0, amSum = 0;
    let centroidNum = 0, centroidDen = 0;
    const melEnergies = new Float64Array(N_MELS);
    
    for (let k = 0; k < fftBins; k++) {
      const mag = Math.sqrt(reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k]);
      flux += Math.max(0, mag - prevMag[k]);
      prevMag[k] = mag;
      
      if (k > 0) {
        gmLog += Math.log(mag + 1e-10);
        amSum += mag;
      }
      
      // Spectral centroid (normalized 0-1 by Nyquist)
      const freq = k * TARGET_SR / FFT_SIZE;
      centroidNum += freq * mag;
      centroidDen += mag;

      for (let m = 0; m < N_MELS; m++) melEnergies[m] += fb[m][k] * mag;
    }
    
    const gm = Math.exp(gmLog / (fftBins - 1));
    const am = (amSum / (fftBins - 1)) + 1e-10;
    const flatness = gm / am;
    
    // Normalized spectral centroid (0.0 = DC, 1.0 = Nyquist)
    const centroid = centroidDen > 1e-10 ? (centroidNum / centroidDen) / (TARGET_SR / 2) : 0;
    
    for (let m = 0; m < N_MELS; m++) melEnergies[m] = Math.log(Math.max(melEnergies[m] / bw[m], 1e-10));
    
    const mfcc = new Float64Array(N_MFCC);
    for (let k = 0; k < N_MFCC; k++) {
      let sum = 0;
      for (let m = 0; m < N_MELS; m++) sum += melEnergies[m] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
      mfcc[k] = sum;
    }
    
    const frameFeatures = new Float32Array(N_FEATURES);
    frameFeatures.set(mfcc, 0);           // [0..12] MFCCs
    frameFeatures[13] = Math.log10(1 + flux); // [13] Spectral Flux
    frameFeatures[14] = rms;              // [14] RMS
    frameFeatures[15] = flatness;         // [15] Spectral Flatness
    frameFeatures[16] = zcrNorm;          // [16] Zero-Crossing Rate
    frameFeatures[17] = centroid;         // [17] Spectral Centroid (normalized)
    
    featureSequence.push(Array.from(frameFeatures));
    if (featureSequence.length > SEQ_LENGTH) featureSequence.shift();
    
    sessionRing = sessionRing.slice(HOP);
    frameCounter++;

    if (featureSequence.length === SEQ_LENGTH && frameCounter % 10 === 0) {
      evaluateSequence();
    }
  }
}

// ── Temporal Confidence Stabilizer ──────────────────────────
let lastAnomaly = null;
let lastAnomalyTime = 0;
let confidenceStreak = 0;

async function evaluateSequence() {
  if (referenceIndex.length === 0) return;

  // STRICT WARMUP GATE: Require exactly 1 second of audio (15600 samples @ 16kHz)
  if (yamnetRing.length < 15600) {
    emitNormal(0, "buffering_1sec_warmup");
    return;
  }

  // ═══════════════════════════════════════════════════════
  // PART 1A: DSP DOMAIN PRE-FILTER (INDEPENDENT OF YAMNET)
  // Must pass BEFORE YAMNet is even consulted.
  // This catches TV/speech/music/ambient via temporal acoustic
  // dynamics — the fastest and most reliable discriminator.
  // ═══════════════════════════════════════════════════════
  const domain = classifyAudioDomain(featureSequence);
  if (domain.humanAudioScore > 0.35) {
    confidenceStreak = 0;
    emitNormal(0, `dsp_pre_reject_score${domain.humanAudioScore.toFixed(2)}`);
    return;
  }

  // ═══════════════════════════════════════════════════════
  // PART 1B: YAMNET DOMAIN CLASSIFIER (FAIL-CLOSED)
  // If YAMNet model has not yet loaded, REJECT ALL AUDIO.
  // Never allow unverified audio to reach DTW inference.
  // ═══════════════════════════════════════════════════════
  let isMechanical = false;
  let topClass = "unknown";

  if (!yamnetModel) {
    // Fail-closed: YAMNet not ready → reject everything.
    // This prevents ALL audio from reaching DTW while the
    // 1.5MB TFHub model is still loading over the network.
    confidenceStreak = 0;
    emitNormal(0, "yamnet_not_ready");
    return;
  }

  {
    const tensor = tf.tensor1d(yamnetRing);
    let preds;
    try {
      preds = yamnetModel.predict(tensor);
    } catch (e) {
      tensor.dispose();
      confidenceStreak = 0;
      emitNormal(0, "yamnet_predict_error");
      return;
    }

    // YAMNet from TFHub returns [scores, embeddings, spectrogram]
    const scoresTensor = Array.isArray(preds) ? preds[0] : preds;
    const scores = await scoresTensor.data();
    if (Array.isArray(preds)) preds.forEach(p => p.dispose()); else preds.dispose();
    tensor.dispose();

    // Top 5 classes for robustness
    const topIndices = Array.from(scores)
      .map((score, i) => ({ score, i }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    topClass = YAMNET_CLASSES[topIndices[0].i] || "unknown";

    // INVERTED ARCHITECTURE: Default = REJECT.
    // Only admit if YAMNet positively confirms mechanical domain in top-5.
    const mechanicalKeywords = [
      'engine', 'mechanisms', 'vehicle', 'gears', 'car', 'motor',
      'idling', 'accelerating', 'squeal', 'hiss', 'rattle', 'knock',
      'mechanical', 'power tool', 'drill', 'chainsaw', 'lawn mower',
      'medium engine', 'heavy engine', 'light engine',
      'engine knocking', 'engine starting'
    ];

    for (let j = 0; j < topIndices.length; j++) {
      const cls = (YAMNET_CLASSES[topIndices[j].i] || "").toLowerCase();
      if (mechanicalKeywords.some(kw => cls.includes(kw))) { isMechanical = true; break; }
    }

    console.log(`[V8 YAMNet] Top: "${topClass}" (${topIndices[0].score.toFixed(3)}) | DSP_human=${domain.humanAudioScore.toFixed(3)} | Mechanical=${isMechanical}`);

    if (!isMechanical) {
      confidenceStreak = 0;
      emitNormal(0, `yamnet_reject_${topClass.replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '')}`);
      return; // ABSOLUTE DOMAIN REJECT
    }
  }

  // ═══════════════════════════════════════════════════════
  // PART 2: THE 6-STAGE STRICT MECHANICAL ADMISSION PIPELINE
  // ═══════════════════════════════════════════════════════
  let maxRMS = 0;
  let sumFlatness = 0;
  let maxFlux = 0;

  for (let i = 0; i < SEQ_LENGTH; i++) {
    const frame = featureSequence[i];
    if (frame[14] > maxRMS) maxRMS = frame[14];
    if (frame[13] > maxFlux) maxFlux = frame[13];
    sumFlatness += frame[15];
  }
  
  const avgFlatness = sumFlatness / SEQ_LENGTH;

  // Gate 1: Strict Silence Reject
  if (maxRMS < 0.015) { 
    confidenceStreak = 0;
    emitNormal(0, "strict_silence");
    return;
  }

  // Gate 2: Strict Flatness Reject
  if (avgFlatness > 0.85) {
    confidenceStreak = 0;
    emitNormal(0, "pure_white_noise");
    return;
  }

  // Gate 3: Transient Periodicity
  if (maxFlux < 0.1) {
    confidenceStreak = 0;
    emitNormal(0, "non_mechanical_flux");
    return;
  }

  // Gate 4: DSP domain already computed above (Part 1A), re-use result
  // (classifyAudioDomain was already called; no need to call again)

  // ═══════════════════════════════════════════════════════
  // PART 3: DTW SEQUENCE ALIGNMENT
  // ═══════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════
  // PART 4: TOP-2 CLASS COLLAPSE MARGIN
  // ═══════════════════════════════════════════════════════
  const separationMargin = secondBestDist - bestDist;
  if (results.length > 1 && separationMargin < 0.25) {
    confidenceStreak = 0;
    emitNormal(0, `ambiguous_margin_${separationMargin.toFixed(2)}`);
    return;
  }

  // ═══════════════════════════════════════════════════════
  // PART 5: BMAD COMPOSITE CONFIDENCE
  // ═══════════════════════════════════════════════════════
  const now = Date.now();
  if (bestDist <= maxDtwDistance && bestMatch) {
    
    if (lastAnomaly === bestMatch.label && (now - lastAnomalyTime < 1500)) {
      confidenceStreak++;
    } else {
      confidenceStreak = 1;
    }
    lastAnomaly = bestMatch.label;
    lastAnomalyTime = now;

    if (confidenceStreak >= 3) {
      const dtwScore = Math.max(0.0, 1.0 - (bestDist / maxDtwDistance));
      const relativeMargin = bestDist > 0.001 ? separationMargin / bestDist : separationMargin * 10;
      const marginBonus = Math.min(1.0, relativeMargin / 5.0);
      const domainPenalty = Math.max(0.3, 1.0 - domain.humanAudioScore);
      
      const finalConfidence = dtwScore * marginBonus * domainPenalty;
      
      if (finalConfidence < 0.10) {
        emitNormal(finalConfidence, "low_composite_confidence");
        return;
      }

      console.log(`[V8 DTW] ✅ "${bestMatch.label}" Dist=${bestDist.toFixed(3)} Margin=${separationMargin.toFixed(2)} YAMNet=${topClass} Conf=${finalConfidence.toFixed(2)}`);
      self.postMessage({
        type: 'result',
        payload: {
          status: 'anomaly', 
          anomaly: bestMatch.label,
          confidence: Math.min(1.0, finalConfidence),
          severity: bestMatch.severity || 'high',
          rms: Math.max(0, maxRMS * 50),
          spectralMeta: {
            rms: maxRMS,
            dtwDistance: bestDist,
            flatness: avgFlatness,
            margin: separationMargin,
            humanAudioScore: domain.humanAudioScore
          }
        }
      });
    } else {
      emitNormal(0.3, "candidate_building");
    }
  } else {
    confidenceStreak = 0;
    emitNormal(0.0, "no_dtw_alignment");
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
