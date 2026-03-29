import Meyda from 'meyda';
import { Logger } from './logger';
import { mixToMono, preprocessSignal, logSignalStats, TARGET_SR } from './audioPreprocessor';
import { generateMelSpectrogram } from './spectrogramGenerator';

const BUFFER_SIZE = 2048;
const FEATURE_SET = ['mfcc', 'rms', 'spectralCentroid', 'zcr', 'spectralFlatness', 'spectralRolloff'];

/**
 * Extracts BOTH:
 *  1. Log-Mel Spectrogram (PRIMARY — for DTW matching & CNN)
 *  2. MFCC mean vector (SECONDARY — fast cosine pre-filter)
 * from a decoded AudioBuffer.
 */
export async function extractFeaturesFromBuffer(audioBuffer) {
  let channelData = mixToMono(audioBuffer);
  
  // Apply identical domain-robust preprocessing
  channelData = preprocessSignal(channelData, audioBuffer.sampleRate);
  logSignalStats(channelData, 'REF POST-PREPROCESS');
  
  // 1. Generate Log-Mel Spectrogram (PRIMARY)
  const spectrogram = generateMelSpectrogram(channelData, audioBuffer.sampleRate);
  
  // 2. Extract MFCC mean vector (SECONDARY pre-filter)
  let validFrames = 0;
  let meanMfcc = Array(13).fill(0);
  let meanRms = 0, meanCentroid = 0, meanZcr = 0, meanFlatness = 0, meanRolloff = 0;
  
  Meyda.bufferSize = BUFFER_SIZE;
  Meyda.sampleRate = audioBuffer.sampleRate;
  
  for (let i = 0; i < channelData.length - BUFFER_SIZE; i += BUFFER_SIZE) {
    const frame = channelData.slice(i, i + BUFFER_SIZE);
    const features = Meyda.extract(FEATURE_SET, frame);
    
    if (features && features.mfcc && features.rms > 0.003) {
      validFrames++;
      for (let j = 0; j < 13; j++) meanMfcc[j] += features.mfcc[j];
      meanRms += features.rms;
      meanCentroid += features.spectralCentroid || 0;
      meanZcr += features.zcr || 0;
      meanFlatness += features.spectralFlatness || 0;
      meanRolloff += features.spectralRolloff || 0;
    }
  }
  
  if (validFrames === 0) return null;
  
  for (let j = 0; j < 13; j++) meanMfcc[j] /= validFrames;
  meanRms /= validFrames;
  meanCentroid /= validFrames;
  meanZcr /= validFrames;
  meanFlatness /= validFrames;
  meanRolloff /= validFrames;
  
  const mfccVector = {
    mfcc: meanMfcc,
    rms: meanRms,
    spectralCentroid: meanCentroid,
    zcr: meanZcr,
    spectralFlatness: meanFlatness,
    spectralRolloff: meanRolloff,
    mfccNorm: Math.sqrt(meanMfcc.reduce((s, v) => s + v * v, 0))
  };
  
  Logger.info(`REF extracted: ${validFrames} frames, spectrogram ${spectrogram.length} values`);
  
  return { 
    mfccVector,
    spectrogram, // Float32Array (128*128) normalized [0,1]
    refSignal: channelData
  };
}
