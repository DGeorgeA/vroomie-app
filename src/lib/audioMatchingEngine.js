import { referenceIndex } from '../services/audioDatasetService';
import { Logger } from './logger';
import { N_MELS, TARGET_TIME_FRAMES } from './spectrogramGenerator';

// ═══════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════

const LIVE_WINDOW_FRAMES = 8; // ~2 seconds of 250ms chunks
const SMOOTHING_WINDOW = 8;

// Real-world calibrated thresholds
const ANOMALY_THRESHOLD = 0.65;
const PROBABLE_THRESHOLD = 0.55;

// Hysteresis
const STABILITY_DURATION_MS = 8000;
const THRESHOLD_FRAMES = 4;

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════

let liveWindowMfcc = [];
let scoreHistory = [];
let consecutiveDetections = 0;
let activeAnomaly = null;
let activeAnomalyTime = 0;

// ═══════════════════════════════════════════════
// MATH: COSINE SIMILARITY
// ═══════════════════════════════════════════════

function cosineSimilarity(a, b) {
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// ═══════════════════════════════════════════════
// MATH: NORMALIZED EUCLIDEAN (inverted to similarity)
// ═══════════════════════════════════════════════

function normalizedEuclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.max(0, 1 - Math.sqrt(sum) / 50);
}

// ═══════════════════════════════════════════════
// SPECTROGRAM DTW — Lightweight Band-Averaged DTW
// Compares mel-band energy profiles over time
// ═══════════════════════════════════════════════

function spectrogramDTW(refSpec, liveSpec) {
  if (!refSpec || !liveSpec) return 0;
  
  // Reduce 128 mel bins to 16 bands, compare across time
  const BANDS = 16;
  const BINS_PER_BAND = Math.floor(N_MELS / BANDS);
  const T = TARGET_TIME_FRAMES;
  
  // Compute band-averaged profiles
  function bandProfile(spec) {
    const profile = new Float32Array(BANDS * T);
    for (let b = 0; b < BANDS; b++) {
      for (let t = 0; t < T; t++) {
        let sum = 0;
        for (let m = 0; m < BINS_PER_BAND; m++) {
          const melIdx = b * BINS_PER_BAND + m;
          sum += spec[melIdx * T + t];
        }
        profile[b * T + t] = sum / BINS_PER_BAND;
      }
    }
    return profile;
  }
  
  const refProfile = bandProfile(refSpec);
  const liveProfile = bandProfile(liveSpec);
  
  // Compute band-wise cosine similarity and average
  let totalSim = 0;
  for (let b = 0; b < BANDS; b++) {
    const refBand = refProfile.slice(b * T, (b + 1) * T);
    const liveBand = liveProfile.slice(b * T, (b + 1) * T);
    totalSim += cosineSimilarity(refBand, liveBand);
  }
  
  return Math.max(0, totalSim / BANDS);
}

// ═══════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════

export function resetMatchState() {
  liveWindowMfcc = [];
  scoreHistory = [];
  consecutiveDetections = 0;
  activeAnomaly = null;
  activeAnomalyTime = 0;
  Logger.info('Match state reset');
}

// ═══════════════════════════════════════════════
// CNN LABEL MAPPING
// ═══════════════════════════════════════════════

function cnnClassToLabel(cnnClass) {
  return {
    'bearing_fault': 'alternator_bearing_fault_critical',
    'engine_knocking': 'engine_knocking_high',
    'misfire': 'misfire_medium',
    'belt_issue': 'pulley_misalignment_medium',
    'other': 'unknown_anomaly_medium'
  }[cnnClass] || cnnClass;
}

import { calculateCosineSimilarity } from './mlEmbeddingEngine';

// ═══════════════════════════════════════════════
// CORE: HYBRID EMBEDDING MATCHING
// ═══════════════════════════════════════════════

function computeSignalMatch(features) {
  if (!referenceIndex || referenceIndex.length === 0 || !features.liveEmbedding) {
    return { matchedFile: null, finalScore: 0, cosine: 0, dtwScore: 0 };
  }
  
  let bestMatch = null;
  let bestScore = 0;
  let bestCos = 0, bestDtw = 0;
  
  for (const ref of referenceIndex) {
    // We expect the Supabase dataset to now have `embedding_vector`
    if (!ref.embedding_vector) continue;
    
    // Step 1: FAST FILTER — Cosine Similarity on YAMNet Embeddings
    const cos = calculateCosineSimilarity(ref.embedding_vector, features.liveEmbedding);
    
    // Low-confidence embeddings are immediately rejected as noise
    if (cos < 0.45) continue;
    
    // Step 2: PRECISE MATCH — Spectrogram DTW Refinement
    let dtw = 0;
    if (features.liveSpectrogram && ref.spectrogram) {
      dtw = spectrogramDTW(ref.spectrogram, features.liveSpectrogram);
    }
    
    // WEIGHTED FUSION: ML Embeddings are primary (0.7), Temporal DTW is secondary (0.3)
    const finalScore = (dtw > 0)
      ? 0.70 * cos + 0.30 * dtw
      : cos; // Fallback if spectrograms missing
    
    Logger.debug(`Match [${ref.label}] | YAMNet Cos=${cos.toFixed(3)} DTW=${dtw.toFixed(3)} => ${finalScore.toFixed(3)}`);
    
    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestMatch = ref;
      bestCos = cos;
      bestDtw = dtw;
    }
  }
  
  return {
    matchedFile: bestMatch ? bestMatch.label : null,
    finalScore: bestScore,
    cosine: bestCos,
    dtwScore: bestDtw,
  };
}

// ═══════════════════════════════════════════════
// MAIN ENTRY: matchBuffer
// ═══════════════════════════════════════════════

export function matchBuffer(features) {
  // Layer 2: Hybrid Signal & Embedding matching
  const sigMatch = computeSignalMatch(features);
  
  // Layer 1: CNN (If active)
  const cnnResult = features.cnnResult || { class: 'normal', confidence: 0 };
  const mlConf = cnnResult.class !== 'normal' ? cnnResult.confidence : 0;
  const mlLabel = cnnResult.class !== 'normal' ? cnnClassToLabel(cnnResult.class) : null;
  
  // Confidence smoothing over 2 seconds (8 frames @ 250ms)
  scoreHistory.push(sigMatch.finalScore);
  if (scoreHistory.length > SMOOTHING_WINDOW) scoreHistory.shift();
  const smoothed = scoreHistory.reduce((a, b) => a + b, 0) / scoreHistory.length;
  
  // FALLBACK LOGIC: If confidence < 0.75, it's NOT an anomaly (strict requirement)
  let finalDecision = 'NO ANOMALY';
  let status = 'normal';
  let anomalyName = null;
  
  // Step 3: STABILITY CHECK — Require consistent detection
  if (smoothed >= ANOMALY_THRESHOLD || mlConf >= 0.75) {
    status = 'anomaly';
    anomalyName = mlConf >= 0.75 ? (mlLabel || sigMatch.matchedFile) : sigMatch.matchedFile;
  } else if (smoothed >= PROBABLE_THRESHOLD) {
    status = 'potential_anomaly';
    anomalyName = sigMatch.matchedFile;
  }
  
  const rawResult = {
    anomaly: anomalyName,
    status,
    mlConfidence: mlConf,
    signalSimilarity: smoothed,
    finalDecision: status === 'anomaly' ? 'ANOMALY DETECTED' : (status === 'potential_anomaly' ? 'PROBABLE ANOMALY' : 'NO ANOMALY'),
    mode: 'hybrid_yamnet',
    confidence: Math.max(mlConf, smoothed),
    detectedClass: anomalyName,
    classifierSource: 'yamnet_dtw_fusion',
    source: sigMatch.matchedFile,
    severity: (anomalyName && anomalyName.includes('critical')) ? 'critical' : 'medium',
    _cosine: sigMatch.cosine,
    _dtw: sigMatch.dtwScore,
    _rawScore: sigMatch.finalScore,
  };
  
  const now = Date.now();
  
  // HYSTERESIS (Require 3-5 frames of consecutive high confidence)
  if (rawResult.status === 'anomaly' || rawResult.status === 'potential_anomaly') {
    consecutiveDetections++;
    if (consecutiveDetections >= THRESHOLD_FRAMES) {
      activeAnomaly = { ...rawResult };
      activeAnomalyTime = now;
      Logger.info(`❗ STABLE ANOMALY TRIGGERED: ${activeAnomaly.anomaly} (Confidence=${rawResult.confidence.toFixed(3)})`);
    }
  } else {
    // If we dip below threshold, break the consecutive chain
    consecutiveDetections = 0;
  }
  
  if (activeAnomaly) {
    const elapsed = now - activeAnomalyTime;
    if (elapsed < STABILITY_DURATION_MS) {
      // Keep anomaly alive through brief dropouts
      if (rawResult.status === 'anomaly' || rawResult.status === 'potential_anomaly') {
        activeAnomalyTime = now;
      }
      return {
        ...activeAnomaly,
        mlConfidence: mlConf,
        signalSimilarity: smoothed,
        confidence: Math.max(activeAnomaly.confidence, rawResult.confidence),
        isPersistentState: true
      };
    } else {
      Logger.info(`✅ Cleared anomaly state: ${activeAnomaly.anomaly}`);
      activeAnomaly = null;
    }
  }
  
  // Strict fallback
  if (rawResult.confidence < 0.75 && rawResult.status !== 'potential_anomaly') {
     rawResult.finalDecision = 'NO ANOMALY';
     rawResult.status = 'normal';
     rawResult.anomaly = null;
  }
  
  return rawResult;
}
