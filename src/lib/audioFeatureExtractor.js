import Meyda from 'meyda';
import { getDetectionMode } from './detectionMode';
import { Logger } from './logger';
import { preprocessSignal, mixToMonoFromRaw, logSignalStats } from './audioPreprocessor';
import { generateMelSpectrogram } from './spectrogramGenerator';
import { predictCNN, isCNNReady } from './cnnClassifier';
import { initializeEmbeddingEngine, getAudioEmbedding, isEngineReady } from './mlEmbeddingEngine';
import { initializeAudioDataset } from '../services/audioDatasetService';

let isExtracting = false;
let audioContext = null;
let scriptProcessor = null;
let mediaStreamSource = null;
let mediaStream = null;
let onFeaturesExtractedCallback = null;

// Rolling 2-second PCM buffer for spectrogram generation
let rollingPCMBuffer = [];
let lastLogTime = 0;
let lastCNNTime = 0;
let lastCNNResult = { class: 'normal', confidence: 0 };
let lastEmbeddingTime = 0;
let latestEmbedding = null;

const FEATURE_SET = ['mfcc', 'rms', 'spectralCentroid', 'zcr', 'spectralFlatness', 'spectralRolloff'];
let datasetInitialized = false;

// CRITICAL: Must be power-of-2 for createScriptProcessor
const SCRIPT_BUFFER_SIZE = 4096;
const MEYDA_BUFFER_SIZE = 2048;

export function registerCNNClassifier(classifier) {
  // CNN is imported directly
}

export function getActiveMediaStream() {
  return mediaStream;
}

export function getActiveAudioContext() {
  return audioContext;
}

export async function startExtraction(callback) {
  if (isExtracting) {
    Logger.warn('Extraction already running.');
    return;
  }
  
  isExtracting = true;
  onFeaturesExtractedCallback = callback;
  rollingPCMBuffer = [];
  latestEmbedding = null;

  // Initialize reference dataset (first time only, cached in IDB after)
  if (!datasetInitialized) {
    datasetInitialized = true;
    initializeAudioDataset().catch(err => Logger.error('Dataset init failed', err));
  }

  // Async background initialization of YAMNet
  initializeEmbeddingEngine().catch(err => Logger.error("Failed to load ML Embedding Engine", err));
  
  console.log('🎤 [START] Requesting microphone permission...');
  
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });
    
    console.log('✅ [MIC] Permission granted, stream active:', mediaStream.active);
    
    // Use browser's native sample rate — do NOT force 16kHz (most browsers reject it)
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    const actualSR = audioContext.sampleRate;
    console.log(`✅ [AUDIO] AudioContext created, sampleRate=${actualSR}`);
    
    mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);
    
    // CRITICAL: buffer size MUST be power of 2 (256, 512, 1024, 2048, 4096, 8192, 16384)
    scriptProcessor = audioContext.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
    
    Meyda.bufferSize = MEYDA_BUFFER_SIZE;
    Meyda.sampleRate = actualSR;
    
    // Compute window size in samples at the actual sample rate (~2 seconds)
    const windowSamples = actualSR * 2;
    
    let frameTick = 0;
    
    console.log('✅ [PIPELINE] ScriptProcessor connected, processing started');
    
    scriptProcessor.onaudioprocess = (e) => {
      if (!isExtracting) return;
      
      const rawInput = mixToMonoFromRaw(e.inputBuffer);
      
      // Apply domain-robust preprocessing
      const processed = preprocessSignal(rawInput, actualSR);
      
      // Throttled signal stats
      const now = Date.now();
      if (now - lastLogTime > 5000) {
        logSignalStats(processed, 'LIVE POST-PREPROCESS');
        lastLogTime = now;
      }
      
      // Accumulate rolling 2-second PCM buffer
      for (let i = 0; i < processed.length; i++) {
        rollingPCMBuffer.push(processed[i]);
      }
      if (rollingPCMBuffer.length > windowSamples) {
        rollingPCMBuffer.splice(0, rollingPCMBuffer.length - windowSamples);
      }
      
      // Extract Meyda features from first 2048 samples of this chunk
      const meydaSlice = processed.length >= MEYDA_BUFFER_SIZE
        ? processed.slice(0, MEYDA_BUFFER_SIZE) 
        : (() => {
            const padded = new Float32Array(MEYDA_BUFFER_SIZE);
            padded.set(processed);
            return padded;
          })();
      
      const features = Meyda.extract(FEATURE_SET, meydaSlice);
      
      if (!features || !features.mfcc) return;
      
      if (frameTick % 30 === 0) {
        console.log("LIVE MFCC[0:5]:", features.mfcc.slice(0, 5));
      }
      frameTick++;
      
      // Generate live spectrogram from rolling 2s buffer (every ~1s = 4 frames)
      let liveSpectrogram = null;
      if (rollingPCMBuffer.length >= windowSamples && frameTick % 4 === 0) {
        const pcm32 = new Float32Array(rollingPCMBuffer);
        liveSpectrogram = generateMelSpectrogram(pcm32, actualSR);
      }
      
      // Run CNN inference periodically
      let cnnResult = lastCNNResult;
      if (isCNNReady() && liveSpectrogram && now - lastCNNTime > 2000) {
        try {
          const pred = predictCNN(liveSpectrogram);
          if (pred) {
            lastCNNResult = pred;
            cnnResult = pred;
            Logger.debug(`CNN: ${pred.class} (${(pred.confidence * 100).toFixed(1)}%)`);
          }
        } catch (err) {
          Logger.error('CNN inference error', err);
        }
        lastCNNTime = now;
      }
      
      // EXTRUDED: RUN YAMNET EMBEDDING EVERY 500ms
      if (isEngineReady() && rollingPCMBuffer.length >= windowSamples && now - lastEmbeddingTime > 500) {
        // Run asynchronously so we don't block the audio thread
        const pcmToEmbed = new Float32Array(rollingPCMBuffer);
        getAudioEmbedding(pcmToEmbed).then(emb => {
          if (emb) latestEmbedding = emb;
        });
        lastEmbeddingTime = now;
      }
      
      if (onFeaturesExtractedCallback) {
        onFeaturesExtractedCallback({
          ...features,
          rawSignalFrame: processed,
          liveSpectrogram,
          liveEmbedding: latestEmbedding,
          cnnResult: getDetectionMode() === 'ml' ? cnnResult : null,
          sampleRate: actualSR,  // CRITICAL: needed for centroid normalization in matching engine
        });
      }
    };
    
    mediaStreamSource.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);
    
    console.log('🟢 [RECORDING] Live extraction started successfully');
    Logger.info(`Live Extraction Started (SR=${actualSR}, buffer=${SCRIPT_BUFFER_SIZE})`);
  } catch (error) {
    console.error('❌ [RECORDING] Failed to start:', error);
    Logger.error('Failed to start extraction', error);
    isExtracting = false;
    throw error;
  }
}

export function stopExtraction() {
  isExtracting = false;
  
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor.onaudioprocess = null;
    scriptProcessor = null;
  }
  if (mediaStreamSource) {
    mediaStreamSource.disconnect();
    mediaStreamSource = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  
  onFeaturesExtractedCallback = null;
  rollingPCMBuffer = [];
  lastCNNResult = { class: 'normal', confidence: 0 };
  console.log('🔴 [RECORDING] Extraction stopped');
  Logger.info('Feature Extraction Stopped');
}
