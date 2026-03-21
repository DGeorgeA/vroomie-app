import Meyda from 'meyda';
import { Logger } from './logger';

let audioContext = null;
let userMediaStream = null;
let meydaAnalyzer = null;
let extractionActive = false;

const MIC_TIMEOUT_MS = 2000;
const NOISE_GATE_RMS = 0.01;

/**
 * Starts microphone capture, wrapped with timeout protection and non-blocking flow.
 * @param {function} onFeaturesExtractedCallback Callback invoked with {mfcc, rms, spectralCentroid}
 */
export async function startExtraction(onFeaturesExtractedCallback) {
  if (extractionActive) return;
  
  try {
    // 1. Initiate Timeout Race for UI safety
    const streamPromise = navigator.mediaDevices.getUserMedia({ 
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 } 
    });
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Microphone initialization timed out (>2s)')), MIC_TIMEOUT_MS)
    );
    
    // Will throw if mic takes > 2s to grant
    userMediaStream = await Promise.race([streamPromise, timeoutPromise]);
    
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(userMediaStream);
    
    // Circular buffer analysis implicitly handled by continuous Meyda chunk loop
    meydaAnalyzer = Meyda.createMeydaAnalyzer({
      audioContext: audioContext,
      source: source,
      bufferSize: 4096,
      featureExtractors: ['mfcc', 'rms', 'spectralCentroid'],
      callback: (features) => {
        // Noise Gate & Performance drop (ignore silent buffers natively to save processing power)
        if (features.rms < NOISE_GATE_RMS) return;
        
        if (onFeaturesExtractedCallback) {
          onFeaturesExtractedCallback(features);
        }
      }
    });
    
    meydaAnalyzer.start();
    extractionActive = true;
    Logger.info("Audio extraction pipeline started and stable");
    
  } catch (error) {
    Logger.error("Pipeline failed to initialize microphone", error);
    stopExtraction();
    throw error;
  }
}

/**
 * Safely tear down resources
 */
export function stopExtraction() {
  extractionActive = false;
  if (meydaAnalyzer) {
    meydaAnalyzer.stop();
    meydaAnalyzer = null;
  }
  if (userMediaStream) {
    userMediaStream.getTracks().forEach(t => t.stop());
    userMediaStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }
  Logger.info("Audio extraction pipeline terminated");
}
