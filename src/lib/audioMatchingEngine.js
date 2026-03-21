import { referenceIndex } from '../services/audioDatasetService';
import { Logger } from './logger';

const MAX_WINDOW_SIZE = 5;
const BASE_CONFIDENCE_THRESHOLD = 0.75; // Lowered from 0.85
const POTENTIAL_THRESHOLD = 0.60;
const MAJORITY_VOTES_REQUIRED = 3;

let matchHistory = [];
let ambientNoiseRmsHistory = [];

function fastCosine(vecA, vecB, normB) {
  let dot = 0, normA_sq = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA_sq += vecA[i] * vecA[i];
  }
  if (normA_sq === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA_sq) * normB);
}

function getDynamicThreshold(currentRms) {
  ambientNoiseRmsHistory.push(currentRms);
  if (ambientNoiseRmsHistory.length > 20) ambientNoiseRmsHistory.shift();
  
  const avgBgNoise = ambientNoiseRmsHistory.reduce((a, b) => a + b, 0) / ambientNoiseRmsHistory.length;
  if (avgBgNoise > 0.15) return { strict: BASE_CONFIDENCE_THRESHOLD + 0.05, potential: POTENTIAL_THRESHOLD + 0.05 }; 
  return { strict: BASE_CONFIDENCE_THRESHOLD, potential: POTENTIAL_THRESHOLD }; 
}

function checkMajorityVoting(historyWindow, strictThreshold, potentialThreshold) {
  const counts = {};
  for (const match of historyWindow) {
    if (!match.label) continue;
    counts[match.label] = (counts[match.label] || 0) + 1;
    if (counts[match.label] >= MAJORITY_VOTES_REQUIRED) {
      return match.label;
    }
  }
  return null;
}

export function matchBuffer(features) {
  if (!referenceIndex || referenceIndex.length === 0) {
    return { anomaly: null, confidence: 0, status: 'normal' };
  }
  
  let bestMatch = null;
  let maxConfidence = 0;
  
  
  const thresholds = getDynamicThreshold(features.rms);
  let liveScoresLog = [];
  
  // 4. Compare Against ALL Sounds (Core Fix)
  for (const ref of referenceIndex) {
    let confidence = fastCosine(features.mfcc, ref.featureVector.mfcc, ref.featureVector.mfccNorm);
    
    // 5. Frequency-Specific Booster (Crucial for Bearing / Alternator squeals)
    // Bearing faults are notoriously high-frequency and steady.
    if (ref.label.toLowerCase().includes('bearing')) {
       // If the live microphone detects high-frequency energy (> 2000 Hz)
       if (features.spectralCentroid > 2000) {
         confidence += 0.12; // Flat 12% confidence boost
       }
       // If the RMS (volume) is stable/distinct (not just transient clicking)
       if (features.rms > 0.05) {
         confidence += 0.05; 
       }
    }
    
    // Clamp at 1.0 (100%)
    confidence = Math.min(1.0, confidence);
    liveScoresLog.push(`${ref.label}: ${(confidence*100).toFixed(1)}%`);
    
    // 6. Select BEST MATCH (Classification)
    if (confidence > maxConfidence) {
      maxConfidence = confidence;
      bestMatch = ref;
    }
  }
  
  // Observability: Log live scores identically against all reference samples
  Logger.debug(`Live Classifier [Strict ${Math.round(thresholds.strict*100)}% | Pot ${Math.round(thresholds.potential*100)}%] -> ${liveScoresLog.join(' | ')}`);
  
  const isMatch = maxConfidence >= thresholds.strict && bestMatch;
  const isPotential = !isMatch && maxConfidence >= thresholds.potential && bestMatch;
  
  const predictedLabel = (isMatch || isPotential) ? bestMatch.label : null;
  
  if (isMatch) {
    Logger.info(`Top match tentatively isolating ${bestMatch.label} (Confidence: ${(maxConfidence*100).toFixed(1)}% - ANOMALY)`);
  } else if (isPotential) {
    Logger.info(`Top match tentatively isolating ${bestMatch.label} (Confidence: ${(maxConfidence*100).toFixed(1)}% - POTENTIAL)`);
  }
  
  // Sliding window queue handling false-positives via spatial persistence
  matchHistory.push({ label: predictedLabel, confidence: maxConfidence });
  if (matchHistory.length > MAX_WINDOW_SIZE) matchHistory.shift();
  
  // Find dominant label in window
  let dominantLabel = null;
  let dominantStatus = 'normal';
  
  const counts = {};
  for (const item of matchHistory) {
    if (!item.label) continue;
    counts[item.label] = (counts[item.label] || 0) + 1;
    if (counts[item.label] >= MAJORITY_VOTES_REQUIRED) {
      dominantLabel = item.label;
      // Re-eval strictness based on the current frame's confidence
      dominantStatus = (maxConfidence >= thresholds.strict) ? 'anomaly' : 'potential_anomaly';
      break;
    }
  }
  
  if (dominantLabel) {
    Logger.info(`==== ${dominantStatus.toUpperCase()} CLASSIFIED ====`, { 
      classifiedMatch: dominantLabel, 
      confidenceTrigger: maxConfidence 
    });
    
    return { 
      anomaly: dominantLabel, 
      confidence: maxConfidence, 
      source: bestMatch?.audioBufferPath,
      status: dominantStatus,
      severity: bestMatch?.label?.split('_').pop() || 'medium'
    };
  }
  
  return { anomaly: null, confidence: maxConfidence, status: 'normal' };
}
