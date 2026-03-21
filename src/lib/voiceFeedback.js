import { Logger } from './logger';

const voiceProfiles = {
  'hi-IN': { pitch: 1.1, rate: 0.9, priorityParams: ['aurora', 'natural', 'premium'] },
  'fr-FR': { pitch: 1.0, rate: 1.05, priorityParams: ['premium', 'natural'] },
  'ar-SA': { pitch: 0.9, rate: 0.95, priorityParams: ['natural'] },
  'ml-IN': { pitch: 1.0, rate: 0.9, priorityParams: ['natural'] },
  'en-US': { pitch: 1.0, rate: 1.0, priorityParams: ['google', 'natural'] },
};

let activeVoice = null;
let activeProfile = null;

let alertInterval = null;
let currentAnomalyName = null;

function initVoices() {
  if (!window.speechSynthesis) return;
  let voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) return assignBestVoice(voices);
  window.speechSynthesis.onvoiceschanged = () => assignBestVoice(window.speechSynthesis.getVoices());
}

/**
 * Iterative fallback matching to ensure the best possible native tone.
 */
function assignBestVoice(voices) {
  const lang = navigator.language || 'en-US';
  const baseLang = lang.split('-')[0];
  activeProfile = voiceProfiles[lang] || voiceProfiles[baseLang] || voiceProfiles['en-US'];
  
  const keywords = activeProfile.priorityParams || ['natural'];
  
  // 1. Exact dialect + Premium/Natural
  let match = voices.find(v => v.lang === lang && keywords.some(k => v.name.toLowerCase().includes(k)));
  // 2. Exact dialect purely
  if (!match) match = voices.find(v => v.lang === lang);
  // 3. Base language + Natural
  if (!match) match = voices.find(v => v.lang.startsWith(baseLang) && keywords.some(k => v.name.toLowerCase().includes(k)));
  // 4. Base language purely
  if (!match) match = voices.find(v => v.lang.startsWith(baseLang));
  // 5. Ultimate Fallback
  if (!match) match = voices.find(v => v.lang === 'en-US');
  
  activeVoice = match || voices[0];
  Logger.debug('Voice Feedback assigned', { voice: activeVoice?.name, lang: activeVoice?.lang });
}

export function speakText(text) {
  if (!window.speechSynthesis) {
    Logger.error('Speech Synthesis API not supported');
    return;
  }
  if (!activeVoice) initVoices();
  
  // Prevent TTS overlap/clipping on continuous streams
  window.speechSynthesis.cancel();
  
  const utterance = new SpeechSynthesisUtterance(text);
  if (activeVoice) {
    utterance.voice = activeVoice;
    utterance.lang = activeVoice.lang;
  }
  if (activeProfile) {
    utterance.pitch = activeProfile.pitch;
    utterance.rate = activeProfile.rate;
  }
  
  Logger.info('Dispatching TTS Announcement', { text });
  window.speechSynthesis.speak(utterance);
}

/**
 * Initiates a continuous 10-second repeating alert loop for severe anomalies.
 */
export function triggerContinuousAlert(anomalyName, isVoiceEnabled = true) {
  if (!isVoiceEnabled) return;

  // Debounce if the exact same anomaly is already triggering to prevent overlapping intervals
  if (currentAnomalyName === anomalyName && alertInterval !== null) return;

  clearContinuousAlert(); // Safely wipe any previous state before starting
  
  currentAnomalyName = anomalyName;
  const alertMessage = `Warning: ${anomalyName} detected. Please check the vehicle.`;
  
  // Speak immediately
  speakText(alertMessage);
  
  // Register strict 10-second looping repeater
  alertInterval = setInterval(() => {
    speakText(alertMessage);
  }, 10000);
}

/**
 * Safely terminates the active repeating TTS alarm.
 */
export function clearContinuousAlert() {
  if (alertInterval) {
    clearInterval(alertInterval);
    alertInterval = null;
  }
  currentAnomalyName = null;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

// Ensure pre-population before button click required
initVoices();
