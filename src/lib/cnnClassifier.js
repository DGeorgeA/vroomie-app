/**
 * CNN Bearing-Specific Classifier — TensorFlow.js
 * Trains in-browser from Supabase audio files, caches model in IndexedDB.
 * Architecture: Conv2D(32) → Pool → Conv2D(64) → Pool → Conv2D(128) → Flatten → Dense(128) → Dense(6, softmax)
 */
import * as tf from '@tensorflow/tfjs';
import { Logger } from './logger';
import { generateMelSpectrogram, N_MELS, TARGET_TIME_FRAMES } from './spectrogramGenerator';

// ─── Target Classes ───────────────────────────────────────
export const CNN_CLASSES = [
  'normal',
  'bearing_fault',
  'engine_knocking',
  'misfire',
  'belt_issue',
  'other'
];

const MODEL_STORAGE_KEY = 'indexeddb://vroomie-cnn-v1';
const INPUT_SHAPE = [N_MELS, TARGET_TIME_FRAMES, 1]; // (128, 128, 1)

let trainedModel = null;
let isModelReady = false;

// ─── Label Mapping ────────────────────────────────────────
/**
 * Maps a Supabase filename to one of the CNN_CLASSES based on keyword matching.
 */
function fileNameToClass(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes('bearing') || lower.includes('alternator')) return 'bearing_fault';
  if (lower.includes('knock') || lower.includes('engine_knock')) return 'engine_knocking';
  if (lower.includes('misfire')) return 'misfire';
  if (lower.includes('belt') || lower.includes('pulley')) return 'belt_issue';
  if (lower.includes('normal') || lower.includes('idle') || lower.includes('smooth')) return 'normal';
  return 'other';
}

// ─── Model Architecture ──────────────────────────────────
function buildModel() {
  const model = tf.sequential();

  model.add(tf.layers.conv2d({
    inputShape: INPUT_SHAPE,
    filters: 32,
    kernelSize: [3, 3],
    activation: 'relu',
    padding: 'same'
  }));
  model.add(tf.layers.maxPooling2d({ poolSize: [2, 2] }));
  model.add(tf.layers.batchNormalization());

  model.add(tf.layers.conv2d({
    filters: 64,
    kernelSize: [3, 3],
    activation: 'relu',
    padding: 'same'
  }));
  model.add(tf.layers.maxPooling2d({ poolSize: [2, 2] }));
  model.add(tf.layers.batchNormalization());

  model.add(tf.layers.conv2d({
    filters: 128,
    kernelSize: [3, 3],
    activation: 'relu',
    padding: 'same'
  }));
  model.add(tf.layers.maxPooling2d({ poolSize: [2, 2] }));

  model.add(tf.layers.flatten());
  model.add(tf.layers.dropout({ rate: 0.3 }));
  model.add(tf.layers.dense({ units: 128, activation: 'relu' }));
  model.add(tf.layers.dropout({ rate: 0.2 }));
  model.add(tf.layers.dense({ units: CNN_CLASSES.length, activation: 'softmax' }));

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: 'categoricalCrossentropy',
    metrics: ['accuracy']
  });

  Logger.info('CNN model architecture built', { 
    params: model.countParams(),
    classes: CNN_CLASSES.length 
  });

  return model;
}

// ─── Data Augmentation ────────────────────────────────────
function augmentSpectrogram(spectrogramFlat) {
  const augmented = [];
  const len = spectrogramFlat.length;

  // Original
  augmented.push(new Float32Array(spectrogramFlat));

  // 1. Add Gaussian noise
  const noisy = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    noisy[i] = spectrogramFlat[i] + (Math.random() - 0.5) * 0.1;
  }
  augmented.push(noisy);

  // 2. Gain variation (simulate volume changes)
  const gained = new Float32Array(len);
  const gain = 0.7 + Math.random() * 0.6; // 0.7 to 1.3
  for (let i = 0; i < len; i++) {
    gained[i] = Math.min(1.0, Math.max(0, spectrogramFlat[i] * gain));
  }
  augmented.push(gained);

  // 3. Frequency masking (zero out a random mel band)
  const freqMasked = new Float32Array(spectrogramFlat);
  const maskStart = Math.floor(Math.random() * (N_MELS - 10));
  const maskWidth = 5 + Math.floor(Math.random() * 10);
  for (let m = maskStart; m < Math.min(maskStart + maskWidth, N_MELS); m++) {
    for (let t = 0; t < TARGET_TIME_FRAMES; t++) {
      freqMasked[m * TARGET_TIME_FRAMES + t] = 0;
    }
  }
  augmented.push(freqMasked);

  // 4. Time masking (zero out a random time slice)
  const timeMasked = new Float32Array(spectrogramFlat);
  const tStart = Math.floor(Math.random() * (TARGET_TIME_FRAMES - 15));
  const tWidth = 5 + Math.floor(Math.random() * 15);
  for (let m = 0; m < N_MELS; m++) {
    for (let t = tStart; t < Math.min(tStart + tWidth, TARGET_TIME_FRAMES); t++) {
      timeMasked[m * TARGET_TIME_FRAMES + t] = 0;
    }
  }
  augmented.push(timeMasked);

  return augmented;
}

// ─── Training Pipeline ───────────────────────────────────
/**
 * Trains the CNN from spectrogram data.
 * @param {Array<{spectrogram: Float32Array, label: string}>} trainingData
 * @returns {tf.LayersModel}
 */
async function trainModel(trainingData) {
  if (trainingData.length === 0) {
    Logger.warn('No training data available for CNN');
    return null;
  }

  const model = buildModel();

  // Augment training data
  const allSpectrograms = [];
  const allLabels = [];

  for (const item of trainingData) {
    const classIndex = CNN_CLASSES.indexOf(item.label);
    if (classIndex === -1) continue;

    const augmented = augmentSpectrogram(item.spectrogram);
    for (const spec of augmented) {
      allSpectrograms.push(spec);
      allLabels.push(classIndex);
    }
  }

  // Also generate synthetic "normal" samples (low energy spectrograms) for balance
  const normalCount = allLabels.filter(l => l === 0).length;
  const faultCount = allLabels.length - normalCount;
  const syntheticNormalNeeded = Math.max(0, faultCount - normalCount);
  
  for (let i = 0; i < syntheticNormalNeeded; i++) {
    const synth = new Float32Array(N_MELS * TARGET_TIME_FRAMES);
    for (let j = 0; j < synth.length; j++) {
      synth[j] = Math.random() * 0.15; // Low energy = "normal" background
    }
    allSpectrograms.push(synth);
    allLabels.push(0);
  }

  Logger.info(`CNN Training data prepared: ${allSpectrograms.length} samples (${syntheticNormalNeeded} synthetic normal)`);

  // Create tensors
  const xs = tf.tensor4d(
    allSpectrograms.flatMap(s => Array.from(s)),
    [allSpectrograms.length, N_MELS, TARGET_TIME_FRAMES, 1]
  );
  
  const ys = tf.oneHot(tf.tensor1d(allLabels, 'int32'), CNN_CLASSES.length);

  // Train
  const epochs = 30;
  Logger.info(`Starting CNN training: ${epochs} epochs, ${allSpectrograms.length} samples...`);

  const history = await model.fit(xs, ys, {
    epochs,
    batchSize: Math.min(16, allSpectrograms.length),
    validationSplit: 0.2,
    shuffle: true,
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        if (epoch % 5 === 0 || epoch === epochs - 1) {
          Logger.info(`Epoch ${epoch + 1}/${epochs} — loss: ${logs.loss.toFixed(4)}, acc: ${logs.acc.toFixed(4)}, val_loss: ${logs.val_loss?.toFixed(4) || 'N/A'}, val_acc: ${logs.val_acc?.toFixed(4) || 'N/A'}`);
        }
      }
    }
  });

  // Cleanup tensors
  xs.dispose();
  ys.dispose();

  const finalAcc = history.history.acc[history.history.acc.length - 1];
  Logger.info(`CNN Training complete! Final accuracy: ${(finalAcc * 100).toFixed(1)}%`);

  // Save to IndexedDB
  try {
    await model.save(MODEL_STORAGE_KEY);
    Logger.info('CNN model cached to IndexedDB');
  } catch (e) {
    Logger.warn('Failed to cache CNN model', e);
  }

  return model;
}

// ─── Model Loading ────────────────────────────────────────
/**
 * Attempts to load cached model from IndexedDB, returns null if not found.
 */
async function loadCachedModel() {
  try {
    const model = await tf.loadLayersModel(MODEL_STORAGE_KEY);
    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy']
    });
    Logger.info('CNN model loaded from IndexedDB cache');
    return model;
  } catch (e) {
    Logger.debug('No cached CNN model found, will train from scratch');
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────

/**
 * Initialize the CNN — load from cache or train from provided audio data.
 * @param {Array<{spectrogram: Float32Array, label: string}>} trainingData
 */
export async function initializeCNN(trainingData) {
  try {
    // Try cache first
    trainedModel = await loadCachedModel();
    
    if (!trainedModel && trainingData && trainingData.length > 0) {
      trainedModel = await trainModel(trainingData);
    }
    
    if (trainedModel) {
      isModelReady = true;
      Logger.info('CNN Classifier is READY for inference');
    } else {
      Logger.warn('CNN Classifier could not be initialized (no model or training data)');
    }
  } catch (err) {
    Logger.error('CNN initialization failed', err);
  }
}

/**
 * Force retrain the model (clear cache and train fresh).
 * @param {Array<{spectrogram: Float32Array, label: string}>} trainingData
 */
export async function retrainCNN(trainingData) {
  try {
    // Clear old model
    if (trainedModel) {
      trainedModel.dispose();
      trainedModel = null;
    }
    isModelReady = false;

    // Remove from IndexedDB
    try {
      await tf.io.removeModel(MODEL_STORAGE_KEY);
    } catch (e) { /* ignore */ }

    trainedModel = await trainModel(trainingData);
    if (trainedModel) {
      isModelReady = true;
    }
  } catch (err) {
    Logger.error('CNN retrain failed', err);
  }
}

/**
 * Run inference on a mel spectrogram.
 * @param {Float32Array} spectrogramFlat - Flat (128*128) normalized mel spectrogram
 * @returns {{ class: string, confidence: number, allScores: Object } | null}
 */
export function predictCNN(spectrogramFlat) {
  if (!isModelReady || !trainedModel) {
    return null;
  }

  try {
    const tensor = tf.tensor4d(
      Array.from(spectrogramFlat),
      [1, N_MELS, TARGET_TIME_FRAMES, 1]
    );

    const prediction = trainedModel.predict(tensor);
    const scores = prediction.dataSync();
    
    tensor.dispose();
    prediction.dispose();

    // Find best class
    let maxScore = 0;
    let maxIndex = 0;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] > maxScore) {
        maxScore = scores[i];
        maxIndex = i;
      }
    }

    const allScores = {};
    CNN_CLASSES.forEach((cls, i) => {
      allScores[cls] = parseFloat(scores[i].toFixed(4));
    });

    return {
      class: CNN_CLASSES[maxIndex],
      confidence: maxScore,
      allScores
    };
  } catch (err) {
    Logger.error('CNN prediction failed', err);
    return null;
  }
}

/**
 * Check if CNN model is ready for predictions.
 */
export function isCNNReady() {
  return isModelReady;
}

/**
 * Maps filename to class label.
 */
export { fileNameToClass };
