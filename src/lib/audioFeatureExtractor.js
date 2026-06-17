import { Logger } from './logger';
import { initializeEmbeddingEngine, getAudioEmbedding, findBestMatch } from './mlEmbeddingEngine';

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

    // Fallback directly to ScriptProcessor for simplicity since we don't need sub-millisecond latency.
    // We just need to capture 1 second of audio (16,000 samples) and process it.
    useScriptProcessorMainThreadCapture(sr);

    Logger.info(`🎙️ Recording started (SR=${sr})`);
  } catch (error) {
    Logger.error('Failed to start extraction:', error);
    isExtracting = false;
    throw error;
  }
}

function useScriptProcessorMainThreadCapture(sr) {
  const windowSamples  = sr * 1; // 1-second window
  const ring       = new Float32Array(windowSamples);
  let writeHead    = 0;
  let totalSamples = 0;

  scriptProcessor = audioContext.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
  
  scriptProcessor.onaudioprocess = async (e) => {
    if (!isExtracting) return;

    const input = e.inputBuffer;
    const numCh = input.numberOfChannels;
    const ch0   = input.getChannelData(0);
    const blockSize = ch0.length;

    let frameRmsSq = 0;

    // Mix mono into ring buffer
    for (let i = 0; i < blockSize; i++) {
      let sample = ch0[i];
      if (numCh > 1) sample = (sample + input.getChannelData(1)[i]) / 2;
      ring[writeHead % windowSamples] = sample;
      writeHead++;
      frameRmsSq += sample * sample;
    }

    const rms = Math.sqrt(frameRmsSq / blockSize);
    totalSamples += blockSize;

    // We only process if we have collected at least 1 second of audio
    // We can evaluate every block (overlapping windows) once we hit the first second.
    if (totalSamples >= windowSamples && totalSamples % (SCRIPT_BUFFER_SIZE * 2) === 0) {
      // Snapshot 1s window in order from ring buffer
      const snapshot = new Float32Array(windowSamples);
      const start = writeHead;
      for (let i = 0; i < windowSamples; i++) {
        snapshot[i] = ring[(start + i) % windowSamples];
      }

      // Hard RMS pre-gate to reject silence
      if (rms < 0.01) {
        if (onFeaturesCallback) {
          onFeaturesCallback({
            _workerResult: { status: 'normal', reason: 'rejected_silence' },
            rms: rms
          });
        }
        return;
      }

      // Pass directly to YAMNet
      const embedding = await getAudioEmbedding(snapshot);
      if (!embedding) return;

      const matchResult = findBestMatch(embedding);

      if (onFeaturesCallback) {
        onFeaturesCallback({
          compositeEmbedding: embedding,
          _workerResult: matchResult, // Matches the worker format expected by AudioRecorder.jsx
          rms: rms
        });
      }
    } else {
      // Just emit buffering state with RMS for the UI
      if (onFeaturesCallback) {
        onFeaturesCallback({
          _workerResult: { status: 'buffering' },
          rms: rms
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
