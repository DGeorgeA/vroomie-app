import * as tf from '@tensorflow/tfjs';
import { Logger } from './logger';
import { loadOrGenerateFingerprints } from './datasetLoader';

const YAMNET_MODEL_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';

let yamnetModel = null;
let isModelLoading = false;
let yamnetFingerprints = [];

// STRICT Cosine Similarity Threshold (0.0 to 1.0)
// Higher = fewer false positives. 0.90 is extremely strict.
const ANOMALY_THRESHOLD = 0.90;

export async function initializeFingerprints() {
  if (yamnetFingerprints.length === 0) {
    yamnetFingerprints = await loadOrGenerateFingerprints(getAudioEmbedding);
  }
}

/**
 * Initializes and caches the YAMNet model.
 */
export async function initializeEmbeddingEngine() {
  await initializeFingerprints(); // Eagerly load fingerprints
  if (yamnetModel) return yamnetModel;
  if (isModelLoading) {
    while (isModelLoading) {
      await new Promise(r => setTimeout(r, 100));
    }
    return yamnetModel;
  }

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
    return null;
  }
}

/**
 * Extracts a sequence embedding from a given audio waveform buffer.
 * @param {Float32Array} pcmData - Raw 16kHz mono audio (1 second)
 * @returns {Array<number>} - 1024-d embedding vector
 */
export async function getAudioEmbedding(pcmData) {
  if (!yamnetModel) {
    await initializeEmbeddingEngine();
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
  return yamnetModel !== null;
}

/**
 * Compares a live 1024-dim embedding against all known references.
 * Returns the best match payload, or 'normal' if none meet the strict threshold.
 */
export function findBestMatch(liveEmbedding) {
  if (!liveEmbedding || !yamnetFingerprints || yamnetFingerprints.length === 0) {
    return { status: 'normal', confidence: 0, reason: 'no_references' };
  }

  let bestScore = -1;
  let bestMatch = null;

  for (const ref of yamnetFingerprints) {
    const score = calculateCosineSimilarity(liveEmbedding, ref.yamnet_embedding);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = ref;
    }
  }

  Logger.debug(`[YAMNet Match] Top match: ${bestMatch?.label} (${bestScore.toFixed(3)})`);

  if (bestScore >= ANOMALY_THRESHOLD && bestMatch) {
    Logger.info(`❗ SEMANTIC MATCH CONFIRMED: ${bestMatch.label} (score=${bestScore.toFixed(3)})`);
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
    reason: `below_threshold_${bestScore.toFixed(2)}`
  };
}
