/**
 * voiceFeedback.js — Vroomie TTS Engine (v4 — POST-RECORDING ONLY)
 *
 * RULES:
 *  1. NO TTS fires during recording.
 *  2. speakText() is the single entry point — called only from handleAudioUpload.
 *  3. triggerContinuousAlert() is a disabled stub (kept for import compatibility).
 *  4. clearContinuousAlert() cancels any in-flight speech when recording starts.
 *  5. Zero pricing, zero repetition.
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

function initVoices() {
  if (!window.speechSynthesis) return;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) return assignBestVoice(voices);
  window.speechSynthesis.onvoiceschanged = () =>
    assignBestVoice(window.speechSynthesis.getVoices());
}

function assignBestVoice(voices) {
  const lang     = navigator.language || 'en-US';
  const baseLang = lang.split('-')[0];
  activeProfile  = voiceProfiles[lang] || voiceProfiles[baseLang] || voiceProfiles['en-US'];
  const kw       = activeProfile.priorityParams || ['natural'];

  let v = voices.find(v => v.lang === lang && kw.some(k => v.name.toLowerCase().includes(k)));
  if (!v) v = voices.find(v => v.lang === lang);
  if (!v) v = voices.find(v => v.lang.startsWith(baseLang) && kw.some(k => v.name.toLowerCase().includes(k)));
  if (!v) v = voices.find(v => v.lang.startsWith(baseLang));
  if (!v) v = voices.find(v => v.lang === 'en-US');
  activeVoice = v || voices[0];
}

/**
 * Speak a message. Called ONLY from handleAudioUpload (post-recording).
 */
export function speakText(text) {
  if (!window.speechSynthesis) return;
  if (!activeVoice) initVoices();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (activeVoice)  { u.voice = activeVoice; u.lang = activeVoice.lang; }
  if (activeProfile){ u.pitch = activeProfile.pitch; u.rate = activeProfile.rate; }
  Logger.info('[TTS]', text);
  window.speechSynthesis.speak(u);
}

/**
 * DISABLED STUB — real-time TTS during recording is prohibited.
 * Kept for import compatibility only.
 */
export function triggerContinuousAlert(_rawLabel, _voiceEnabled) {
  // Intentionally empty — all voice output is post-recording.
  // Use speakText() from handleAudioUpload instead.
}

/**
 * Cancel any in-flight speech (called when recording starts).
 */
export function clearContinuousAlert() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

initVoices();
