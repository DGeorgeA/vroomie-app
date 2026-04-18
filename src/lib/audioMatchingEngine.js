import { referenceIndex } from '../services/audioDatasetService';
import { Logger } from './logger';
import { N_MELS, TARGET_TIME_FRAMES } from './spectrogramGenerator';

// ═══════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════

const LIVE_WINDOW_FRAMES = 8; // ~2 seconds of 250ms chunks
const SMOOTHING_WINDOW = 8;

// ─── Calibrated real-world thresholds ────────────────────────────────────────
// MFCC cosine similarity between live mic and WAV reference is inherently lower
// than embedding-to-embedding comparison (different acoustic conditions, hardware,
// ambient noise). Values calibrated against known belt, bearing, and knock recordings.
//
// ANOMALY_THRESHOLD  : minimum smoothed score to declare a confirmed anomaly
// PROBABLE_THRESHOLD : minimum score to flag a "potential anomaly"
// MIN_LIVE_RMS       : below this RMS level the signal is silence/music — skip matching entirely
const ANOMALY_THRESHOLD   = 0.42; // was 0.65 — too strict for cross-condition MFCC match
const PROBABLE_THRESHOLD  = 0.30; // was 0.55 — must catch "potential anomaly" cases
const MIN_LIVE_RMS        = 0.005; // ~−46 dBFS — below this is silence, breath, or background music

// ─── Hysteresis / stability requirements ─────────────────────────────────────
const STABILITY_DURATION_MS = 5000; // was 8000 — faster lock-in
const THRESHOLD_FRAMES      = 2;    // was 4 — require 2 consecutive hits (not 4)

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

// ═══════════════════════════════════════════════
// CORE: HYBRID EMBEDDING MATCHING
// Handles three cases:
//   1. YAMNet live (1024-dim) vs MFCC-padded ref (1024-dim) → use first N_ALIGN dims
//   2. Meyda MFCC live (13-dim) vs MFCC-padded ref (1024-dim) → use first 13 dims
//   3. No reference embeddings → returns zero match
// ═══════════════════════════════════════════════

const N_ALIGN = 40; // Compare first 40 dims — covers the full MFCC spectral content

function alignAndCompare(liveVec, refVec) {
  if (!liveVec || !refVec) return 0;
  // Take the shorter of the two aligned windows
  const n = Math.min(liveVec.length, refVec.length, N_ALIGN);
  const live = liveVec.slice(0, n);
  const ref  = refVec.slice(0, n);
  return cosineSimilarity(live, ref);
}

function computeSignalMatch(features) {
  if (!referenceIndex || referenceIndex.length === 0) {
    return { matchedFile: null, finalScore: 0, cosine: 0, dtwScore: 0 };
  }

  // ── Build the live comparison vector ──────────────────────────────────────
  // Priority: YAMNet 1024-dim > Meyda MFCC 13-dim array > null
  let liveVec = null;

  if (features.liveEmbedding && features.liveEmbedding.length >= N_ALIGN) {
    // YAMNet embedding — use first N_ALIGN dims
    liveVec = Array.from(features.liveEmbedding).slice(0, N_ALIGN);
  } else if (features.mfcc && features.mfcc.length > 0) {
    // Meyda MFCC (13-dim by default) — pad with zeros to N_ALIGN
    liveVec = Array.from(features.mfcc);
    while (liveVec.length < N_ALIGN) liveVec.push(0);
  }

  if (!liveVec) {
    return { matchedFile: null, finalScore: 0, cosine: 0, dtwScore: 0 };
  }

  // L2-normalise the live vector
  const norm = Math.sqrt(liveVec.reduce((s, v) => s + v * v, 0)) || 1;
  liveVec = liveVec.map(v => v / norm);

  let bestMatch = null;
  let bestScore = 0;
  let bestCos = 0, bestDtw = 0;

  for (const ref of referenceIndex) {
    if (!ref.embedding_vector) continue;

    // Cosine similarity against first N_ALIGN dims of the stored 1024-dim vector
    const cos = alignAndCompare(liveVec, ref.embedding_vector);

    if (cos < 0.25) continue; // Widened fast rejection (was 0.35)

    // Spectrogram DTW refinement (if available)
    let dtw = 0;
    if (features.liveSpectrogram && ref.spectrogram) {
      dtw = spectrogramDTW(ref.spectrogram, features.liveSpectrogram);
    }

    // Weighted fusion: embedding primary (0.7), DTW refinement (0.3)
    const finalScore = dtw > 0 ? 0.70 * cos + 0.30 * dtw : cos;

    Logger.debug(`[MATCH] ${ref.label?.padEnd(45)} | cos=${cos.toFixed(4)} dtw=${dtw.toFixed(4)} final=${finalScore.toFixed(4)}`);

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestMatch = ref;
      bestCos = cos;
      bestDtw = dtw;
    }
  }

  return {
    matchedFile: bestMatch ? (bestMatch.label || bestMatch.source_file) : null,
    finalScore: bestScore,
    cosine: bestCos,
    dtwScore: bestDtw,
  };
}


// ═══════════════════════════════════════════════
// MAIN ENTRY: matchBuffer
// ═══════════════════════════════════════════════

export function matchBuffer(features) {
  // ── Live energy gate: reject silence, speech, and non-automotive signals ──
  // If the live RMS is below MIN_LIVE_RMS the mic is capturing
  // silence, breath, music, or background noise — no point comparing against
  // automotive anomaly references.
  if ((features.rms || 0) < MIN_LIVE_RMS) {
    console.debug(`[Vroomie Detection] Energy gate: RMS=${(features.rms || 0).toFixed(5)} < ${MIN_LIVE_RMS} — skipping match (silence/noise)`);
    return {
      anomaly: null,
      status: 'normal',
      confidence: 0,
      finalDecision: 'NO ANOMALY',
      mode: 'hybrid_mfcc',
      mlConfidence: 0,
      signalSimilarity: 0,
      detectedClass: null,
      classifierSource: 'energy_gate',
      source: null,
      severity: 'low',
    };
  }

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
    finalDecision: status === 'anomaly'
      ? 'ANOMALY DETECTED'
      : status === 'potential_anomaly'
        ? 'PROBABLE ANOMALY — FURTHER ANALYSIS RECOMMENDED'
        : 'NO ANOMALY',
    mode: 'hybrid_mfcc',
    confidence: Math.max(mlConf, smoothed),
    detectedClass: anomalyName,
    classifierSource: 'mfcc_cosine_dtw',
    source: sigMatch.matchedFile,
    severity: (
      anomalyName?.includes('critical') ? 'critical' :
      anomalyName?.includes('high')     ? 'high'     :
      anomalyName?.includes('medium')   ? 'medium'   : 'low'
    ),
    _cosine: sigMatch.cosine,
    _dtw: sigMatch.dtwScore,
    _rawScore: sigMatch.finalScore,
  };

  // ── Structured diagnostic log (visible in browser DevTools > Console) ──────
  if (sigMatch.finalScore > 0.1 || smoothed > 0.1 || mlConf > 0.1) {
    console.log(
      `[Vroomie Detection] label: ${sigMatch.matchedFile || 'none'} | ` +
      `signal_conf: ${smoothed.toFixed(3)} | ml_conf: ${mlConf.toFixed(3)} | ` +
      `decision: ${rawResult.finalDecision} | rms: ${(features.rms || 0).toFixed(5)}`
    );
  }

  
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
