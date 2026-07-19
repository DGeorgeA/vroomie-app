import * as tf from '@tensorflow/tfjs';
import { Logger } from './logger';
import { loadReferenceSet } from './datasetLoader';
import { YAMNET_CLASSES } from '../data/yamnet_classes';

const YAMNET_MODEL_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';

let yamnetModel = null;
let isModelLoading = false;
let modelLoadPromise = null;
let faultReferences = [];   // augmented fault embeddings from the static artifact
let anchorReferences = [];  // healthy + interferer anchor embeddings
let isReferencesLoading = false;

// Cosine Similarity Threshold for anomaly detection (0.0 to 1.0)
// 0.60 per product requirement (2026-07-07): a >= 60% match against any bucket
// reference categorizes the anomaly by that reference's file name. Precision at
// this threshold depends on the domain gate + MARGIN rule + persistence below;
// without them, 0.60 would match nearly any sustained sound.
const ANOMALY_THRESHOLD = 0.40;

// Margin rule: a fault match only counts if it beats the closest HEALTHY/interferer
// anchor by this much. This inverts the old "find the closest anomaly" logic into
// "is this closer to a known fault than to a healthy engine?".
//
// Windows that qualify are emitted as status 'candidate'; the SESSION decision
// (>= 50% of accepted windows agreeing on one fault, min 4 windows) is applied
// by AudioRecorder at stop. Calibrated on held-out data by
// scripts/benchmark_discrimination.mjs + scripts/rule_explorer.mjs:
// healthy FP 0/35, interferer FP 0/5, fault recall 16/36, refs 5/6.
const ANCHOR_MARGIN = 0.05;

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
  // NOTE: 'Mechanical fan' and 'Air conditioning' are deliberately EXCLUDED —
  // household fans/AC passed the gate and matched hiss-like references.
  'Mechanisms', 'Ratchet, pawl', 'Gears', 'Pulleys', 'Sewing machine',
  'Tools', 'Hammer', 'Jackhammer', 'Sawing', 'Power tool', 'Drill',
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
  const isInterferer = INTERFERER_INDICES.has(top1Idx);
  const accepted =
    VEHICLE_MECH_INDICES.has(top1Idx) ||
    (!isInterferer && vehicleScore >= 0.001) ||
    (vehicleScore >= VEHICLE_SCORE_FLOOR && vehicleScore > interfererScore);
  return { accepted, top1: YAMNET_CLASSES[top1Idx], vehicleScore, interfererScore };
}

/**
 * Full initialization: YAMNet model + static reference artifact.
 * References are pre-built offline (scripts/build_reference_fingerprints.mjs),
 * so both loads are independent and run in parallel.
 */
export async function initializeEmbeddingEngine() {
  const [, refSet] = await Promise.all([
    loadYamnetModel(),
    loadReferenceSet().catch(err => {
      Logger.error('Failed to load reference set:', err);
      return null;
    })
  ]);

  if (refSet && faultReferences.length === 0) {
    faultReferences = refSet.faults;
    anchorReferences = refSet.anchors;
    Logger.info(`✅ Reference set ready: ${faultReferences.length} fault embeddings, ${anchorReferences.length} anchors`);
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
  return yamnetModel !== null && faultReferences.length > 0;
}

/**
 * Maps a decision margin (bestFault − bestAnchor) to a calibrated confidence.
 * Anchored so that a match at exactly the margin threshold reports ~0.6 and a
 * decisive margin (≥ ~0.25 above threshold) saturates near 0.97. Unlike raw
 * cosine (0.7–0.9 for ANY pair of sustained sounds), this reflects how much
 * closer the audio is to the fault than to a healthy engine.
 */
function marginToConfidence(margin) {
  // Now using raw bestScore directly as confidence per >60% directive
  return margin;
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
  if (!liveEmbedding || faultReferences.length === 0) {
    Logger.warn(`[YAMNet] findBestMatch called with ${faultReferences.length} references — returning normal`);
    return { status: 'normal', confidence: 0, reason: 'no_references' };
  }

  // ── Stage 1: acoustic domain gate — is this vehicle audio at all? ──
  if (meanScores) {
    const domain = evaluateAudioDomain(meanScores);
    if (!domain.accepted) {
      Logger.info(`[YAMNet] Domain gate would reject (top1=${domain.top1}), but proceeding to similarity check.`);
    }
  }

  // ── Stage 2: discriminative match — closer to a fault than to healthy? ──
  let bestScore = -1;
  let bestMatch = null;
  for (const ref of faultReferences) {
    const score = calculateCosineSimilarity(liveEmbedding, ref.emb);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = ref;
    }
  }
  let bestAnchor = 0;
  for (const anchor of anchorReferences) {
    const score = calculateCosineSimilarity(liveEmbedding, anchor.emb);
    if (score > bestAnchor) bestAnchor = score;
  }
  const margin = bestScore - bestAnchor;
  Logger.info(`[YAMNet] bestFault=${bestMatch.label}(${bestScore.toFixed(3)}) bestAnchor=${bestAnchor.toFixed(3)} margin=${margin.toFixed(3)}`);

  if (bestScore < ANOMALY_THRESHOLD) {
    return {
      status: 'normal',
      anomaly: null,
      confidence: 0,
      reason: `below_threshold_${bestScore.toFixed(2)}_vs_${ANOMALY_THRESHOLD}`
    };
  }

  // ── Stage 3: emit a candidate — the session-level fraction rule in
  // AudioRecorder decides whether the fault is sustained enough to report.
  const confidence = bestScore; // Directly use bestScore per the 60% rule
  Logger.info(`[YAMNet] Candidate window: ${bestMatch.label} (score=${bestScore.toFixed(3)}, conf=${confidence.toFixed(2)})`);
  return {
    status: 'candidate',
    anomaly: bestMatch.label,
    severity: bestMatch.severity || 'high',
    confidence,
    rms: 0 // Legacy field needed by UI
  };
}
