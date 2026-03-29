import * as tf from '@tensorflow/tfjs';
import { Logger } from './logger';

// ═══════════════════════════════════════════════════════════
// YAMNet EMBEDDING ENGINE
// Loads a pre-trained YAMNet model from TF Hub to extract 
// robust 1024-dimensional sequence embeddings from 16kHz audio.
// ═══════════════════════════════════════════════════════════

const YAMNET_MODEL_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';

let yamnetModel = null;
let isModelLoading = false;

/**
 * Initializes and caches the YAMNet model.
 */
export async function initializeEmbeddingEngine() {
  if (yamnetModel) return yamnetModel;
  if (isModelLoading) {
    // Wait until loaded
    while (isModelLoading) {
      await new Promise(r => setTimeout(r, 100));
    }
    return yamnetModel;
  }

  isModelLoading = true;
  try {
    Logger.info('Loading YAMNet Embedding Model from TF Hub...');
    // TF Hub YAMNet takes Float32Array waveform directly and outputs [scores, embeddings, spectrogram]
    // The waveform must be 16kHz mono.
    yamnetModel = await tf.loadGraphModel(YAMNET_MODEL_URL, { fromTFHub: true });
    
    // Warm up the model
    const dummyInput = tf.zeros([16000]); // 1 second of 16kHz
    const [scores, embeddings, spectrogram] = yamnetModel.predict(dummyInput);
    
    // Cleanup warmup tensors
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
 * YAMNet inherently computes the 96x64 Log-Mel spectrogram internally,
 * so we can pass the raw 16kHz PCM directly to the graph!
 * 
 * @param {Float32Array} pcmData - Raw 16kHz mono audio (ideally ~1 to 2 seconds)
 * @returns {Float32Array} - The mean-pooled 1024-d embedding vector representing the entire clip
 */
export async function getAudioEmbedding(pcmData) {
  if (!yamnetModel) {
    await initializeEmbeddingEngine();
  }
  if (!yamnetModel) return null;

  return tf.tidy(() => {
    // 1. Convert to tensor
    const waveformTensor = tf.tensor1d(pcmData);
    
    // 2. Predict (returns [scores, embeddings, spectrogram])
    // embeddings shape: [N_frames, 1024] where N_frames depends on audio length (approx 2 frames per second)
    const [scores, embeddings, spectrogram] = yamnetModel.predict(waveformTensor);
    
    // 3. We want a single embedding vector to represent the whole clip.
    // Mean pool across the time dimension (axis 0)
    const meanEmbedding = tf.mean(embeddings, 0);
    
    // 4. Return as standard Javascript Array/Float32Array for cosine similarity
    const embeddingArray = meanEmbedding.dataSync();
    
    return Array.from(embeddingArray);
  });
}

/**
 * Convenience function to measure Cosine Similarity between two embedding arrays.
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
