import * as tf from '@tensorflow/tfjs';
import { Logger } from './logger';
import { loadOrGenerateFingerprints } from './datasetLoader';

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
 */
export function findBestMatch(liveEmbedding) {
  if (!liveEmbedding || !yamnetFingerprints || yamnetFingerprints.length === 0) {
    Logger.warn(`[YAMNet] findBestMatch called with ${yamnetFingerprints?.length || 0} references — returning normal`);
    return { status: 'normal', confidence: 0, reason: 'no_references' };
  }

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
    Logger.info(`❗ ANOMALY CONFIRMED: ${bestMatch.label} (score=${bestScore.toFixed(3)} >= ${ANOMALY_THRESHOLD})`);
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
