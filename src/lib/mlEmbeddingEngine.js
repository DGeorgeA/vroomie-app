import * as tf from '@tensorflow/tfjs';
import { Logger } from './logger';
import { loadOrGenerateFingerprints } from './datasetLoader';
import { YAMNET_CLASSES } from '../data/yamnet_classes';

const YAMNET_MODEL_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';

let yamnetModel = null;
let isModelLoading = false;
let modelLoadPromise = null;
let yamnetFingerprints = [];
let isFingerprintsLoading = false;

// Cosine Similarity Threshold for anomaly detection (0.0 to 1.0)
// 0.75 balances sensitivity and precision for real-world microphone audio.
// Real-world audio has environmental noise, reverb, and mic response curves
// that reduce similarity vs clean WAV references — 0.90 rejects everything.
const ANOMALY_THRESHOLD = 0.75;

// ─── Acoustic domain gate ─────────────────────────────────────────────────────
// YAMNet embeddings of ANY two audible sounds (speech, music, engines) routinely
// exceed 0.75 cosine similarity, so similarity alone cannot tell "TV dialogue"
// from "bearing whine". YAMNet's 521-class scores output CAN: it directly
// recognises Speech/Music/Television vs Engine/Vehicle/Mechanisms. A window is
// only eligible for fingerprint matching when it acoustically belongs to the
// vehicle/mechanical domain.
const VEHICLE_MECH_NAMES = [
  'Vehicle', 'Motor vehicle (road)', 'Car', 'Vehicle horn, car horn, honking', 'Car alarm',
  'Power windows, electric windows', 'Skidding', 'Tire squeal', 'Car passing by',
  'Race car, auto racing', 'Truck', 'Air brake', 'Air horn, truck horn', 'Reversing beeps',
  'Bus', 'Motorcycle', 'Traffic noise, roadway noise',
  'Engine', 'Light engine (high frequency)', 'Medium engine (mid frequency)',
  'Heavy engine (low frequency)', 'Engine knocking', 'Engine starting', 'Idling',
  'Accelerating, revving, vroom', 'Lawn mower', 'Chainsaw',
  'Mechanisms', 'Ratchet, pawl', 'Gears', 'Pulleys', 'Sewing machine', 'Mechanical fan',
  'Air conditioning', 'Tools', 'Hammer', 'Jackhammer', 'Sawing', 'Power tool', 'Drill',
  'Rattle', 'Squeak', 'Squeal', 'Whir', 'Hum', 'Vibration', 'Throbbing', 'Rumble',
  'Clicking', 'Tick', 'Clatter', 'Creak', 'Scrape', 'Grind'
];
const VEHICLE_MECH_INDICES = new Set(
  VEHICLE_MECH_NAMES.map(n => YAMNET_CLASSES.indexOf(n)).filter(i => i >= 0)
);
// Interferers: every human-sound class (Speech … up to Animal), every music
// class (Music … up to Wind), plus broadcast/silence classes.
const INTERFERER_INDICES = (() => {
  const set = new Set();
  const animalStart = YAMNET_CLASSES.indexOf('Animal');
  const musicStart = YAMNET_CLASSES.indexOf('Music');
  const windStart = YAMNET_CLASSES.indexOf('Wind');
  for (let i = 0; i < animalStart; i++) set.add(i);
  for (let i = musicStart; i < windStart; i++) set.add(i);
  ['Television', 'Radio', 'Silence', 'Whistling', 'Whistle'].forEach(name => {
    const i = YAMNET_CLASSES.indexOf(name);
    if (i >= 0) set.add(i);
  });
  return set;
})();
// Minimum vehicle/mechanical class score for a window to count as vehicle audio.
// Validated offline (scripts/validate_anomaly_accuracy.mjs): genuine fault
// recordings score 0.03–0.65 on vehicle classes while speech/music/ambient noise
// score 0.00–0.02, so the margin test (vehicle > interferer) does the real work.
const VEHICLE_SCORE_FLOOR = 0.03;

// Persistence: a fault must match in 2 windows within a session (or once with
// near-perfect similarity) before it is reported. Real mechanical faults are
// sustained; one-off spurious matches are not.
const PERSISTENCE_HITS = 2;
const SINGLE_HIT_BYPASS_SCORE = 0.95;
let candidateHits = new Map();

export function resetDetectionState() {
  candidateHits = new Map();
}

/**
 * Loads the YAMNet model only. No fingerprint loading.
 * This must complete before getAudioEmbedding can be called.
 */
async function loadYamnetModel() {
  if (yamnetModel) return yamnetModel;
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    isModelLoading = true;
    try {
      Logger.info('Loading YAMNet Embedding Model from TF Hub...');
      yamnetModel = await tf.loadGraphModel(YAMNET_MODEL_URL, { fromTFHub: true });
      
      // Warm up the model
      const dummyInput = tf.zeros([16000]); // 1 second of 16kHz
      const [scores, embeddings, spectrogram] = yamnetModel.predict(dummyInput);
      
      scores.dispose();
      embeddings.dispose();
      spectrogram.dispose();
      dummyInput.dispose();
      
      Logger.info('✅ YAMNet Model Loaded & Warmed Up');
      isModelLoading = false;
      return yamnetModel;
    } catch (error) {
      Logger.error('Failed to load YAMNet model:', error);
      isModelLoading = false;
      modelLoadPromise = null;
      return null;
    }
  })();

  return modelLoadPromise;
}

/**
 * Extracts a sequence embedding from a given audio waveform buffer.
 * @param {Float32Array} pcmData - Raw 16kHz mono audio (1 second)
 * @returns {Array<number>} - 1024-d embedding vector
 */
export async function getAudioEmbedding(pcmData) {
  // Ensure model is loaded first — calls loadYamnetModel (NOT initializeEmbeddingEngine)
  // This prevents the circular dependency with fingerprint loading
  if (!yamnetModel) {
    await loadYamnetModel();
  }
  if (!yamnetModel) return null;

  return tf.tidy(() => {
    const waveformTensor = tf.tensor1d(pcmData);
    const [scores, embeddings, spectrogram] = yamnetModel.predict(waveformTensor);
    const meanEmbedding = tf.mean(embeddings, 0);
    return Array.from(meanEmbedding.dataSync());
  });
}

/**
 * Extracts BOTH the mean embedding and the mean 521-class scores for a window.
 * The scores drive the acoustic domain gate in findBestMatch.
 * @param {Float32Array} pcmData - Raw 16kHz mono audio (1 second)
 * @returns {{embedding: Array<number>, meanScores: Array<number>}|null}
 */
export async function getAudioAnalysis(pcmData) {
  if (!yamnetModel) {
    await loadYamnetModel();
  }
  if (!yamnetModel) return null;

  return tf.tidy(() => {
    const waveformTensor = tf.tensor1d(pcmData);
    const [scores, embeddings, spectrogram] = yamnetModel.predict(waveformTensor);
    const embedding = Array.from(tf.mean(embeddings, 0).dataSync());
    const meanScores = Array.from(tf.mean(scores, 0).dataSync());
    return { embedding, meanScores };
  });
}

/**
 * Acoustic domain gate. Decides whether a window is vehicle/mechanical audio
 * (eligible for fingerprint matching) or an interferer (speech/music/TV/etc).
 */
export function evaluateAudioDomain(meanScores) {
  if (!meanScores || meanScores.length !== YAMNET_CLASSES.length) {
    // Fail open only for malformed input — matching still requires the 0.75 gate
    return { accepted: true, top1: 'unknown', vehicleScore: 0, interfererScore: 0 };
  }
  let top1Idx = 0, vehicleScore = 0, interfererScore = 0;
  for (let i = 0; i < meanScores.length; i++) {
    if (meanScores[i] > meanScores[top1Idx]) top1Idx = i;
    if (VEHICLE_MECH_INDICES.has(i) && meanScores[i] > vehicleScore) vehicleScore = meanScores[i];
    if (INTERFERER_INDICES.has(i) && meanScores[i] > interfererScore) interfererScore = meanScores[i];
  }
  const accepted =
    VEHICLE_MECH_INDICES.has(top1Idx) ||
    (vehicleScore >= VEHICLE_SCORE_FLOOR && vehicleScore > interfererScore);
  return { accepted, top1: YAMNET_CLASSES[top1Idx], vehicleScore, interfererScore };
}

/**
 * Full initialization: loads model first, then generates/loads fingerprints.
 * This is the public entry point called by audioFeatureExtractor.startExtraction().
 * 
 * ORDER IS CRITICAL:
 *   1. Load YAMNet model (so getAudioEmbedding works)
 *   2. Load/generate fingerprints (which calls getAudioEmbedding for each WAV)
 */
export async function initializeEmbeddingEngine() {
  // Step 1: Load the model FIRST (no fingerprint dependency)
  await loadYamnetModel();

  // Step 2: Load fingerprints (needs working getAudioEmbedding, which needs the model)
  if (yamnetFingerprints.length === 0 && !isFingerprintsLoading) {
    isFingerprintsLoading = true;
    try {
      yamnetFingerprints = await loadOrGenerateFingerprints(getAudioEmbedding);
      Logger.info(`✅ ${yamnetFingerprints.length} fingerprints loaded/generated`);
    } catch (err) {
      Logger.error('Failed to load fingerprints:', err);
    } finally {
      isFingerprintsLoading = false;
    }
  }

  return yamnetModel;
}

/**
 * Measures Cosine Similarity between two embedding arrays.
 */
export function calculateCosineSimilarity(emb1, emb2) {
  if (!emb1 || !emb2 || emb1.length !== emb2.length) return 0;
  
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  
  for (let i = 0; i < emb1.length; i++) {
    dotProduct += emb1[i] * emb2[i];
    norm1 += emb1[i] * emb1[i];
    norm2 += emb2[i] * emb2[i];
  }
  
  if (norm1 === 0 || norm2 === 0) return 0;
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

export function isEngineReady() {
  return yamnetModel !== null && yamnetFingerprints.length > 0;
}

/**
 * Compares a live 1024-dim embedding against all known references.
 * Returns the best match payload, or 'normal' if none meet the threshold.
 *
 * @param {Array<number>} liveEmbedding - 1024-d mean YAMNet embedding
 * @param {Array<number>|null} meanScores - 521-d mean YAMNet class scores for
 *        the same window. When provided, the acoustic domain gate runs first:
 *        speech/music/TV/ambient windows are rejected before any fingerprint
 *        comparison, because embedding similarity alone cannot separate them
 *        from fault recordings.
 */
export function findBestMatch(liveEmbedding, meanScores = null) {
  if (!liveEmbedding || !yamnetFingerprints || yamnetFingerprints.length === 0) {
    Logger.warn(`[YAMNet] findBestMatch called with ${yamnetFingerprints?.length || 0} references — returning normal`);
    return { status: 'normal', confidence: 0, reason: 'no_references' };
  }

  // ── Stage 1: acoustic domain gate ──
  if (meanScores) {
    const domain = evaluateAudioDomain(meanScores);
    if (!domain.accepted) {
      Logger.info(`[YAMNet] Domain gate REJECT: top1=${domain.top1} vehicle=${domain.vehicleScore.toFixed(2)} interferer=${domain.interfererScore.toFixed(2)}`);
      return {
        status: 'normal',
        anomaly: null,
        confidence: 0,
        reason: `rejected_domain_${domain.top1}`
      };
    }
  }

  // ── Stage 2: fingerprint similarity ──
  let bestScore = -1;
  let bestMatch = null;

  // Log ALL reference comparisons for diagnostics
  const allScores = [];
  for (const ref of yamnetFingerprints) {
    const score = calculateCosineSimilarity(liveEmbedding, ref.yamnet_embedding);
    allScores.push({ label: ref.label, score: score.toFixed(4) });
    if (score > bestScore) {
      bestScore = score;
      bestMatch = ref;
    }
  }

  // Log top 3 matches for debugging
  allScores.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
  const top3 = allScores.slice(0, 3).map(s => `${s.label}(${s.score})`).join(', ');
  Logger.info(`[YAMNet] Top matches: ${top3} | Threshold: ${ANOMALY_THRESHOLD}`);

  if (bestScore >= ANOMALY_THRESHOLD && bestMatch) {
    // ── Stage 3: persistence ──
    const hits = (candidateHits.get(bestMatch.label) || 0) + 1;
    candidateHits.set(bestMatch.label, hits);
    if (hits < PERSISTENCE_HITS && bestScore < SINGLE_HIT_BYPASS_SCORE) {
      Logger.info(`[YAMNet] Candidate pending confirmation: ${bestMatch.label} (score=${bestScore.toFixed(3)}, hit ${hits}/${PERSISTENCE_HITS})`);
      return {
        status: 'normal',
        anomaly: null,
        confidence: bestScore,
        reason: 'pending_confirmation'
      };
    }
    Logger.info(`❗ ANOMALY CONFIRMED: ${bestMatch.label} (score=${bestScore.toFixed(3)} >= ${ANOMALY_THRESHOLD}, hits=${hits})`);
    return {
      status: 'anomaly',
      anomaly: bestMatch.label,
      severity: bestMatch.severity || 'high',
      confidence: bestScore,
      rms: 0 // Legacy field needed by UI
    };
  }

  return {
    status: 'normal',
    anomaly: null,
    confidence: bestScore,
    reason: `below_threshold_${bestScore.toFixed(2)}_vs_${ANOMALY_THRESHOLD}`
  };
}
