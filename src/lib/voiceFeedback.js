/**
 * voiceFeedback.js — Vroomie TTS Engine
 *
 * FIXED:
 *  1. triggerContinuousAlert no longer repeats on a loop (10s interval removed).
 *     One-shot TTS per confirmed anomaly, de-bounced by anomaly label.
 *  2. No pricing mentioned anywhere in TTS output.
 *  3. Message format: "Potential [name] detected. Please visit a workshop..."
 *  4. speakText is public so handleAudioUpload can call it for post-recording summary.
 */

import { Logger } from './logger';

const voiceProfiles = {
  'hi-IN': { pitch: 1.1, rate: 0.9,  priorityParams: ['aurora', 'natural', 'premium'] },
  'fr-FR': { pitch: 1.0, rate: 1.05, priorityParams: ['premium', 'natural'] },
  'ar-SA': { pitch: 0.9, rate: 0.95, priorityParams: ['natural'] },
  'ml-IN': { pitch: 1.0, rate: 0.9,  priorityParams: ['natural'] },
  'en-US': { pitch: 1.0, rate: 1.0,  priorityParams: ['google', 'natural'] },
};

let activeVoice   = null;
let activeProfile = null;

// ─── De-bounce state — prevents speaking the same anomaly more than once ──────
let lastSpokenAnomaly = null;

function initVoices() {
  if (!window.speechSynthesis) return;
  let voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) return assignBestVoice(voices);
  window.speechSynthesis.onvoiceschanged = () => assignBestVoice(window.speechSynthesis.getVoices());
}

function assignBestVoice(voices) {
  const lang     = navigator.language || 'en-US';
  const baseLang = lang.split('-')[0];
  activeProfile  = voiceProfiles[lang] || voiceProfiles[baseLang] || voiceProfiles['en-US'];

  const keywords = activeProfile.priorityParams || ['natural'];

  let match = voices.find(v => v.lang === lang && keywords.some(k => v.name.toLowerCase().includes(k)));
  if (!match) match = voices.find(v => v.lang === lang);
  if (!match) match = voices.find(v => v.lang.startsWith(baseLang) && keywords.some(k => v.name.toLowerCase().includes(k)));
  if (!match) match = voices.find(v => v.lang.startsWith(baseLang));
  if (!match) match = voices.find(v => v.lang === 'en-US');

  activeVoice = match || voices[0];
  Logger.debug('Voice assigned', { voice: activeVoice?.name });
}

export function speakText(text) {
  if (!window.speechSynthesis) return;
  if (!activeVoice) initVoices();

  // Cancel any in-flight utterance to prevent overlap
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  if (activeVoice)  { utterance.voice = activeVoice; utterance.lang = activeVoice.lang; }
  if (activeProfile){ utterance.pitch = activeProfile.pitch; utterance.rate = activeProfile.rate; }

  Logger.info('TTS', { text });
  window.speechSynthesis.speak(utterance);
}

/**
 * Speaks a ONE-SHOT alert for a confirmed anomaly.
 * Will NOT speak again if the same anomaly label is already active.
 * Does NOT loop — avoids the double-speech problem.
 *
 * @param {string}  anomalyRawLabel  - raw label from matching engine (e.g. "bearing_fault_alternator_bearing_fault_critical")
 * @param {boolean} isVoiceEnabled   - from settings store
 */
export function triggerContinuousAlert(anomalyRawLabel, isVoiceEnabled = true) {
  if (!isVoiceEnabled) return;

  // De-bounce: same anomaly already spoken this session
  if (lastSpokenAnomaly === anomalyRawLabel) return;
  lastSpokenAnomaly = anomalyRawLabel;

  // Build a clean human-readable name from the raw label
  // Format: <category>_<descriptive_parts...>_<severity>
  const parts = anomalyRawLabel.split('_');
  let readableName = anomalyRawLabel;

  if (parts.length >= 3) {
    // Drop the category prefix (first part) and severity suffix (last part)
    const severity = parts[parts.length - 1].toLowerCase();
    const isKnownSeverity = ['critical', 'high', 'medium', 'low'].includes(severity);
    const middleParts = isKnownSeverity ? parts.slice(1, -1) : parts.slice(1);
    readableName = middleParts.join(' ');
  } else if (parts.length === 2) {
    readableName = parts[1];
  }

  // Title-case
  readableName = readableName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).trim();

  // NO PRICING. Workshop referral only.
  const message = `Potential ${readableName} detected. Please visit a workshop and share your Vroomie report for further inspection.`;

  speakText(message);
  Logger.info(`[TTS] Anomaly alert spoken: "${message}"`);
}

/**
 * Clears the active anomaly de-bounce so the next detection cycle
 * can speak again (called when recording stops or restarts).
 */
export function clearContinuousAlert() {
  lastSpokenAnomaly = null;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

// Pre-populate voices before first button click
initVoices();
