/**
 * audioFeatureExtractor.js — Vroomie Audio Pipeline Orchestrator (v8 — Off-Thread)
 *
 * Architecture:
 *   [Mic] → [AudioWorklet: vroomie-processor] → postMessage PCM (every 500ms, zero-copy)
 *         → [Main Thread relay] → [featureWorker Web Worker: preprocess + FFT + embed + match]
 *         → postMessage result → [callback on Main Thread]
 *
 * Main thread only manages lifecycle. All audio math is off-thread.
 */

import { getDetectionMode } from './detectionMode';
import { Logger } from './logger';
import { referenceIndex, initializeAudioDataset, audio_matching_final_v5_hardened } from '../services/audioDatasetService';
import { computeCompositeEmbedding } from './audioMath_v11';
import { initializeEmbeddingEngine, getAudioEmbedding, isEngineReady } from './mlEmbeddingEngine';

// ─── Module-level state ───────────────────────────────────
let isExtracting        = false;
let audioContext        = null;
let workletNode         = null;
let mediaStreamSource   = null;
let mediaStream         = null;
let featureWorker       = null;
let onFeaturesCallback  = null;
let datasetInitialized  = false;

// For waveform rendering (analyser stays on main thread — lightweight)
let analyserNode = null;

// Fallback ScriptProcessor for browsers without AudioWorklet support
let scriptProcessor = null;
const SCRIPT_BUFFER_SIZE = 4096;

// ─── Public API ───────────────────────────────────────────

export function getActiveMediaStream()   { return mediaStream; }
export function getActiveAudioContext()  { return audioContext; }
export function registerCNNClassifier()  { /* CNN handled in worker */ }

// ─── Dataset initialisation (called once by App.jsx startup) ─────────────────

// Track whether we've already pushed refs to the worker this session
let refsSentToWorker = false;

export async function startExtraction(callback) {
  if (isExtracting) {
    Logger.warn('Extraction already running.');
    return;
  }

  isExtracting       = true;
  onFeaturesCallback = callback;
  refsSentToWorker   = false;

  // Ensure dataset is loaded BEFORE mic opens (critical for matching)
  if (!datasetInitialized || referenceIndex.length === 0) {
    datasetInitialized = true;
    Logger.info('[Extractor] Awaiting dataset initialization...');
    await initializeAudioDataset().catch(err => Logger.error('Dataset init failed', err));
  }
  Logger.info(`[Extractor] Dataset ready: ${referenceIndex.length} reference patterns loaded`);

  Logger.info('🎤 [START] Requesting microphone...');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const sr = audioContext.sampleRate;
    Logger.info(`✅ AudioContext sampleRate=${sr}`);

    mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);

    // Lightweight analyser for waveform UI only — does NOT block
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 1024; // smaller than before (was 2048)
    mediaStreamSource.connect(analyserNode);

    // Spawn the Web Worker (module worker for ESM support)
    const workerUrl = audio_matching_final_v5_hardened
      ? new URL('../workers/AudioV5_SuperProcessor.worker.js', import.meta.url)
      : new URL('../workers/featureWorker.js', import.meta.url);

    featureWorker = new Worker(workerUrl, { type: 'module' });

    // Set thresholds in worker (dual-gate: absolute + margin)
    featureWorker.postMessage({ type: 'setThresholds', payload: { absThreshold: 0.72, margin: 0.04, rmsGate: 0.005 } });

    // Send reference index ONCE (not per frame — expensive serialization)
    const sendRefsToWorker = () => {
      if (refsSentToWorker) return;
      if (referenceIndex && referenceIndex.length > 0) {
        featureWorker.postMessage({ type: 'setReferenceIndex', payload: referenceIndex });
        refsSentToWorker = true;
        Logger.info(`[Extractor] Sent ${referenceIndex.length} reference embeddings to worker`);
      }
    };
    sendRefsToWorker();

    // Handle results coming BACK from worker (tiny objects, fast)
    featureWorker.onmessage = (ev) => {
      const { type, payload } = ev.data;
      if (type === 'result' && onFeaturesCallback) {
        // Translate worker result to the format AudioRecorder.jsx expects
        onFeaturesCallback({
          compositeEmbedding: payload.compositeEmbedding || null,
          rawSignalFrame:     null,
          liveSpectrogram:    null,
          liveEmbedding:      null,
          cnnResult:          null,
          sampleRate:         sr,
          _workerResult:      payload,
          rms:                payload.rms || 0,
          spectralCentroid:   0,
        });
      } else if (type === 'error') {
        Logger.error('Worker error:', payload);
      }
    };

    featureWorker.onerror = (err) => {
      Logger.error('Feature worker crashed:', err.message);
    };

    // Try AudioWorklet first, fall back to ScriptProcessor
    const useWorklet = !!audioContext.audioWorklet;

    if (useWorklet) {
      try {
        await audioContext.audioWorklet.addModule('/audio-processor.worklet.js');

        workletNode = new AudioWorkletNode(audioContext, 'vroomie-processor', {
          processorOptions: { sampleRate: sr },
          numberOfInputs:  1,
          numberOfOutputs: 0,
        });

        // Relay PCM from AudioWorklet thread → Web Worker (zero-copy, NO ref index per frame)
        workletNode.port.onmessage = (ev) => {
          if (!isExtracting || !featureWorker) return;
          // Send refs if they just loaded (lazy, once only)
          sendRefsToWorker();
          const { buffer, sampleRate } = ev.data;
          featureWorker.postMessage(
            { type: 'process', payload: { buffer, sampleRate } },
            [buffer.buffer]
          );
        };

        mediaStreamSource.connect(workletNode);
        Logger.info('🟢 AudioWorklet pipeline active');
      } catch (workletErr) {
        Logger.warn('AudioWorklet failed, falling back to ScriptProcessor:', workletErr.message);
        useScriptProcessorFallback(sr);
      }
    } else {
      Logger.warn('AudioWorklet not supported, using ScriptProcessor fallback');
      useScriptProcessorFallback(sr);
    }

    Logger.info(`🎙️ Recording started (SR=${sr})`);
  } catch (error) {
    Logger.error('Failed to start extraction:', error);
    isExtracting = false;
    throw error;
  }
}

// ─── ScriptProcessor fallback (for Safari < 14.1) ────────
// Still does processing in worker, just the PCM capture is on main thread
function useScriptProcessorFallback(sr) {
  const windowSamples  = sr * 2; // 2-second window
  const dispatchEvery  = Math.ceil(sr * 0.5); // every 500ms
  
  // Use a typed circular ring buffer (avoids push/splice GC)
  const ring       = new Float32Array(windowSamples);
  let writeHead    = 0;
  let sinceDispatch = 0;
  let totalSamples = 0;

  scriptProcessor = audioContext.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
  scriptProcessor.onaudioprocess = (e) => {
    if (!isExtracting) return;

    const input = e.inputBuffer;
    const numCh = input.numberOfChannels;
    const ch0   = input.getChannelData(0);
    const blockSize = ch0.length;

    // Mix mono into ring buffer — O(blockSize) only, no allocation
    for (let i = 0; i < blockSize; i++) {
      let sample = ch0[i];
      if (numCh > 1) sample = (sample + input.getChannelData(1)[i]) / 2;
      ring[writeHead % windowSamples] = sample;
      writeHead++;
    }

    totalSamples  += blockSize;
    sinceDispatch += blockSize;

    if (sinceDispatch >= dispatchEvery && totalSamples >= windowSamples) {
      sinceDispatch = 0;

      // Snapshot 2s window in order from ring buffer
      const snapshot = new Float32Array(windowSamples);
      const start = writeHead; // oldest sample
      for (let i = 0; i < windowSamples; i++) {
        snapshot[i] = ring[(start + i) % windowSamples];
      }

      // Send refs once lazily (reuse closure from parent scope)
      if (typeof sendRefsToWorker === 'function') sendRefsToWorker();

      featureWorker.postMessage(
        { type: 'process', payload: { buffer: snapshot, sampleRate: sr } },
        [snapshot.buffer]
      );
    }
  };

  // ScriptProcessor must connect to destination to fire (silent output)
  mediaStreamSource.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);
  Logger.info('ScriptProcessor fallback active');
}

// ─── Stop Extraction ───────────────────────────────────────
export function stopExtraction() {
  isExtracting = false;

  // Signal worklet to stop
  if (workletNode) {
    workletNode.port.postMessage('stop');
    workletNode.disconnect();
    workletNode = null;
  }

  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor.onaudioprocess = null;
    scriptProcessor = null;
  }

  // ─── FIX: Capture callback BEFORE nulling it ──────────────────────────────
  // The v5 worker only emits a result on 'stop' — never per frame.
  // The previous code nulled onFeaturesCallback immediately, so the worker's
  // final detection result was always silently dropped.
  // Solution: rewire onmessage on the retiring worker to deliver the final
  // result via the captured callback, then terminate the worker.
  if (featureWorker) {
    const workerToTerminate = featureWorker;
    const finalCallback     = onFeaturesCallback; // capture before null

    workerToTerminate.onmessage = (ev) => {
      const { type, payload } = ev.data;
      if (type === 'result' && finalCallback) {
        finalCallback({
          compositeEmbedding: null,
          rawSignalFrame:     null,
          liveSpectrogram:    null,
          liveEmbedding:      null,
          cnnResult:          null,
          sampleRate:         0,
          _workerResult:      payload,
          rms:                payload.rms || 0,
          spectralCentroid:   0,
        });
      }
      try { workerToTerminate.terminate(); } catch (_) {}
    };

    featureWorker.postMessage({ type: 'stop' });
    featureWorker = null;

    // Safety terminate in case worker never responds
    setTimeout(() => { try { workerToTerminate.terminate(); } catch (_) {} }, 1500);
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (analyserNode) {
    analyserNode.disconnect();
    analyserNode = null;
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
