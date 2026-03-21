import { referenceIndex } from '../services/audioDatasetService';
import { Logger } from './logger';

const MAX_WINDOW_SIZE = 5;
const BASE_CONFIDENCE_THRESHOLD = 0.85; 
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
  if (avgBgNoise > 0.15) return BASE_CONFIDENCE_THRESHOLD + 0.05; 
  return BASE_CONFIDENCE_THRESHOLD; 
}

function checkMajorityVoting(historyWindow) {
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
    return { anomaly: null, confidence: 0 };
  }
  
  let bestMatch = null;
  let maxConfidence = 0;
  
  const currentThreshold = getDynamicThreshold(features.rms);
  let liveScoresLog = [];
  
  // 4. Compare Against ALL Sounds (Core Fix)
  for (const ref of referenceIndex) {
    const confidence = fastCosine(features.mfcc, ref.featureVector.mfcc, ref.featureVector.mfccNorm);
    liveScoresLog.push(`${ref.label}: ${(confidence*100).toFixed(1)}%`);
    
    // 5. Select BEST MATCH (Classification)
    if (confidence > maxConfidence) {
      maxConfidence = confidence;
      bestMatch = ref;
    }
  }
  
  // Observability: Log live scores identically against all reference samples
  Logger.info(`Live Classifier [Threshold ${Math.round(currentThreshold*100)}%] -> ${liveScoresLog.join(' | ')}`);
  
  const isMatch = maxConfidence >= currentThreshold && bestMatch;
  const predictedLabel = isMatch ? bestMatch.label : null;
  
  if (isMatch) {
    Logger.info(`Top match tentatively isolating ${bestMatch.label} (Confidence: ${(maxConfidence*100).toFixed(1)}%)`);
  }
  
  // Sliding window queue handling false-positives via spatial persistence
  matchHistory.push({ label: predictedLabel, confidence: maxConfidence });
  if (matchHistory.length > MAX_WINDOW_SIZE) matchHistory.shift();
  
  const majorityLabel = checkMajorityVoting(matchHistory);
  
  if (majorityLabel) {
    Logger.info("==== ANOMALY LOCKED VIA MULTI-SOUND CLASSIFIER ====", { 
      classifiedMatch: majorityLabel, 
      confidenceTrigger: maxConfidence
    });
    
    matchHistory = []; 
    return { anomaly: majorityLabel, confidence: maxConfidence, source: bestMatch?.source };
  }
  
  return { anomaly: null, confidence: maxConfidence };
}
