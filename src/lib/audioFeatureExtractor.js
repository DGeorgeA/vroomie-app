import { Logger } from './logger';
import { initializeEmbeddingEngine, getAudioAnalysis, findBestMatch } from './mlEmbeddingEngine';
import { linearResample, applyPhoneBand } from './audioPreprocessor';

// ─── Module-level state ───────────────────────────────────
let isExtracting        = false;
let audioContext        = null;
let mediaStreamSource   = null;
let mediaStream         = null;
let scriptProcessor     = null;
let onFeaturesCallback  = null;

const TARGET_SR = 16000;
const SCRIPT_BUFFER_SIZE = 4096;

// ─── Public API ───────────────────────────────────────────

export function getActiveMediaStream()   { return mediaStream; }
export function getActiveAudioContext()  { return audioContext; }

export async function startExtraction(callback) {
  if (isExtracting) {
    Logger.warn('Extraction already running.');
    return;
  }

  isExtracting       = true;
  onFeaturesCallback = callback;

  Logger.info('🎤 [START] Requesting microphone and loading YAMNet...');

  try {
    // Eagerly load YAMNet
    await initializeEmbeddingEngine();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_SR });
    const sr = audioContext.sampleRate;
    Logger.info(`✅ AudioContext sampleRate=${sr}`);

    mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessor capture — processes 1-second windows for YAMNet classification
    useScriptProcessorMainThreadCapture(sr);

    Logger.info(`🎙️ Recording started (SR=${sr})`);
  } catch (error) {
    Logger.error('Failed to start extraction:', error);
    isExtracting = false;
    throw error;
  }
}

function useScriptProcessorMainThreadCapture(sr) {
  const windowSamples  = sr * 1; // 1-second window (16000 samples at 16kHz)
  const ring       = new Float32Array(windowSamples);
  let writeHead    = 0;
  let totalSamples = 0;
  let isProcessing = false; // Prevent overlapping async YAMNet calls
  let lastClassifyTime = 0; // Timestamp of last classification attempt

  scriptProcessor = audioContext.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
  
  scriptProcessor.onaudioprocess = async (e) => {
    if (!isExtracting) return;

    const input = e.inputBuffer;
    const numCh = input.numberOfChannels;
    const ch0   = input.getChannelData(0);
    const blockSize = ch0.length;

    // Mix mono into ring buffer and accumulate RMS
    for (let i = 0; i < blockSize; i++) {
      let sample = ch0[i];
      if (numCh > 1) sample = (sample + input.getChannelData(1)[i]) / 2;
      ring[writeHead % windowSamples] = sample;
      writeHead++;
    }

    totalSamples += blockSize;

    // ── Classification gate: process every ~1 second, AFTER we have at least 1s of data ──
    // Use wall-clock timing instead of fragile modulo arithmetic to ensure classification fires reliably
    const now = performance.now();
    const hasEnoughData = totalSamples >= windowSamples;
    const timeSinceLastClassify = now - lastClassifyTime;

    if (hasEnoughData && timeSinceLastClassify >= 900 && !isProcessing) {
      lastClassifyTime = now;
      isProcessing = true;

      // Snapshot the full 1-second window in order from ring buffer
      const snapshot = new Float32Array(windowSamples);
      const start = writeHead;
      for (let i = 0; i < windowSamples; i++) {
        snapshot[i] = ring[(start + i) % windowSamples];
      }

      // Mathematical parity with build_reference_fingerprints.mjs (Resample to 16kHz)
      // YAMNet STRICTLY requires 16000 Hz. If device mic is 48kHz, passing 48000 samples 
      // will down-pitch the audio by 3x and destroy the acoustic fingerprint.
      const resampledSnapshot = linearResample(snapshot, sr, 16000);
      const resampledLen = resampledSnapshot.length;

      // Compute RMS over the FULL 1-second snapshot (not just the current block)
      // This prevents intermittent silence rejections when individual blocks are quiet
      let snapshotRmsSq = 0;
      for (let i = 0; i < resampledLen; i++) {
        snapshotRmsSq += resampledSnapshot[i] * resampledSnapshot[i];
      }
      const rms = Math.sqrt(snapshotRmsSq / resampledLen);

      // Hard RMS pre-gate to reject silence
      if (rms < 0.01) {
        if (onFeaturesCallback) {
          onFeaturesCallback({
            _workerResult: { status: 'normal', reason: 'rejected_silence' },
            rms: rms
          });
        }
        isProcessing = false;
        return;
      }

      // Mathematical parity with build_reference_fingerprints.mjs (RMS norm to 0.05)
      const targetRms = 0.05;
      const gain = targetRms / Math.max(rms, 1e-6);
      const normalizedSnapshot = new Float32Array(resampledLen);
      for (let i = 0; i < resampledLen; i++) {
        normalizedSnapshot[i] = Math.max(-1, Math.min(1, resampledSnapshot[i] * gain));
      }

      // Mathematical parity with build_reference_fingerprints.mjs (Phone bandpass sim)
      // The offline generator applies this AFTER RMS normalization to simulate a mobile mic.
      // Since live web tests can be from laptops (which lack this hardware curve), we must explicitly apply it.
      const finalSnapshot = applyPhoneBand(normalizedSnapshot, 16000);

      try {
        // Pass the full 1-second 16kHz normalized+bandpassed snapshot to YAMNet
        const analysis = await getAudioAnalysis(finalSnapshot);
        if (!analysis) {
          isProcessing = false;
          return;
        }

        const matchResult = findBestMatch(analysis.embedding, analysis.meanScores);

        if (onFeaturesCallback) {
          onFeaturesCallback({
            compositeEmbedding: analysis.embedding,
            _workerResult: matchResult,
            rms: rms
          });
        }
      } catch (err) {
        Logger.error('Classification error:', err);
      } finally {
        isProcessing = false;
      }
    } else if (!hasEnoughData) {
      // Compute block-level RMS for UI feedback while buffering
      let frameRmsSq = 0;
      for (let i = 0; i < blockSize; i++) {
        frameRmsSq += ch0[i] * ch0[i];
      }
      const blockRms = Math.sqrt(frameRmsSq / blockSize);

      if (onFeaturesCallback) {
        onFeaturesCallback({
          _workerResult: { status: 'buffering' },
          rms: blockRms
        });
      }
    }
  };

  // ScriptProcessor must connect to destination to fire
  mediaStreamSource.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);
  Logger.info('Main thread audio capture active');
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

  onFeaturesCallback = null;
  Logger.info('🔴 Extraction stopped — all resources released');
}
