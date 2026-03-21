import Meyda from 'meyda';
import { Logger } from './logger';

/**
 * Extracts reference features mathematically identical to strict real-time Web Audio API Meyda outputs.
 * Uses an array slice method directly to chunk through the decoded buffer.
 * 
 * @param {AudioBuffer} audioBuffer Fully decoded 16kHz Mono audio buffer
 * @returns {Object} average vectors { mfcc, rms, spectralCentroid }
 */
export async function extractFeaturesFromBuffer(audioBuffer) {
  Logger.info("Initiating identical offline Meyda extraction on reference buffer", { 
    durationSeconds: audioBuffer.duration, 
    sampleRate: audioBuffer.sampleRate 
  });
  
  const bufferSize = 4096;
  const channelData = audioBuffer.getChannelData(0); // Assuming mono or utilizing left channel
  
  let totalWindows = 0;
  let mfccSums = new Array(13).fill(0);
  let rmsSum = 0;
  let centroidSum = 0;
  
  // Slide through the array exactly identically to how getUserMedia chunking operates over time
  for (let i = 0; i < channelData.length - bufferSize; i += bufferSize) {
    const frame = channelData.slice(i, i + bufferSize);
    
    // Meyda natively supports extracting directly from a contiguous Float32Array locally without a context node attached
    const features = Meyda.extract(['mfcc', 'rms', 'spectralCentroid'], frame);
    
    if (features && features.mfcc) {
      if (features.rms < 0.005) continue; // Noise gate identically applied
      
      for (let j = 0; j < 13; j++) {
        mfccSums[j] += features.mfcc[j];
      }
      rmsSum += features.rms;
      centroidSum += features.spectralCentroid;
      totalWindows++;
    }
  }
  
  if (totalWindows === 0) {
    Logger.warn("Offline reference vector contained zero valid frames above noise gate.");
    return null;
  }
  
  return {
    mfcc: mfccSums.map(sum => sum / totalWindows),
    rms: rmsSum / totalWindows,
    spectralCentroid: centroidSum / totalWindows
  };
}
