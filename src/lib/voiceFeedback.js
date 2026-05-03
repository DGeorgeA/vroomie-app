/**
 * voiceFeedback.js — Vroomie TTS Engine v5 — Native-Quality Multilingual
 *
 * RULES:
 *  1. NO TTS fires during recording.
 *  2. speakText() is the SINGLE entry point — called only from handleAudioUpload.
 *  3. Uses user's selected language from settingsStore (not navigator.language).
 *  4. Selects best voice for locale: Google/Apple/Premium voices preferred.
 *  5. clearContinuousAlert() cancels any in-flight speech when recording starts.
 *  6. Zero pricing, zero repetition.
 *
 * LANGUAGE → LOCALE MAPPING:
 *  en-US → Google US English / en-US
 *  en-IN → Google Hindi / en-IN
 *  hi-IN → Google हिन्दी / hi-IN
 *  ta-IN → ta-IN
 *  te-IN → te-IN
 *  kn-IN → kn-IN
 *  ar-SA → ar-SA
 *  es-ES → es-ES
 *  fr-FR → fr-FR
 */

import { Logger } from './logger';

// ─── Voice profile per locale ─────────────────────────────────────────────────
const VOICE_PROFILES = {
  'en-US': { pitch: 1.0, rate: 1.0,  lang: 'en-US', keywords: ['google', 'natural', 'premium', 'enhanced'] },
  'en-IN': { pitch: 1.0, rate: 0.95, lang: 'en-IN', keywords: ['google', 'natural', 'premium', 'enhanced'] },
  'hi-IN': { pitch: 1.1, rate: 0.9,  lang: 'hi-IN', keywords: ['google', 'natural', 'हिन्दी', 'premium'] },
  'ta-IN': { pitch: 1.0, rate: 0.88, lang: 'ta-IN', keywords: ['google', 'natural', 'premium'] },
  'te-IN': { pitch: 1.0, rate: 0.88, lang: 'te-IN', keywords: ['google', 'natural', 'premium'] },
  'kn-IN': { pitch: 1.0, rate: 0.88, lang: 'kn-IN', keywords: ['google', 'natural', 'premium'] },
  'ar-SA': { pitch: 0.95, rate: 0.9, lang: 'ar-SA', keywords: ['google', 'natural', 'premium'] },
  'es-ES': { pitch: 1.0, rate: 1.0,  lang: 'es-ES', keywords: ['google', 'natural', 'premium'] },
  'fr-FR': { pitch: 1.0, rate: 1.05, lang: 'fr-FR', keywords: ['google', 'natural', 'premium'] },
  'ml-IN': { pitch: 1.0, rate: 0.9,  lang: 'ml-IN', keywords: ['google', 'natural', 'premium'] },
};

// Text translations for common phrases (fallback: English)
const TRANSLATIONS = {
  'hi-IN': {
    scanComplete:   'स्कैन पूरी हुई।',
    issueDetected:  'समस्या मिली:',
    noAnomaly:      'कोई समस्या नहीं मिली।',
    visitWorkshop:  'कृपया कार वर्कशॉप जाएं।',
  },
  'ta-IN': {
    scanComplete:   'ஸ்கேன் முடிந்தது.',
    issueDetected:  'பிரச்சனை கண்டுபிடிக்கப்பட்டது:',
    noAnomaly:      'எந்த பிரச்சனையும் இல்லை.',
    visitWorkshop:  'தயவுசெய்து ஒரு வொர்க்ஷாப்பிற்கு வாருங்கள்.',
  },
};

const DEFAULT_PHRASES = {
  scanComplete:  'Scan complete.',
  issueDetected: 'Issue detected:',
  noAnomaly:     'No anomalies found. Your vehicle sounds healthy.',
  visitWorkshop: 'Please visit a workshop and share your Vroomie report.',
};

// ─── Voice Cache ──────────────────────────────────────────────────────────────
let _cachedVoice   = null;
let _cachedProfile = null;
let _cachedLang    = null;

function selectVoice(targetLang) {
  // Return cache if language hasn't changed
  if (targetLang === _cachedLang && _cachedVoice) return { voice: _cachedVoice, profile: _cachedProfile };

  const voices  = window.speechSynthesis?.getVoices() || [];
  if (voices.length === 0) return { voice: null, profile: VOICE_PROFILES['en-US'] };

  const profile = VOICE_PROFILES[targetLang] || VOICE_PROFILES['en-US'];
  const lang    = profile.lang;
  const baseLang = lang.split('-')[0];
  const kw      = profile.keywords || ['natural'];

  // Priority: exact lang match + keyword > exact lang > base lang + keyword > base lang > en-US
  let v = voices.find(v => v.lang === lang    && kw.some(k => v.name.toLowerCase().includes(k)));
  if (!v) v = voices.find(v => v.lang === lang);
  if (!v) v = voices.find(v => v.lang.startsWith(baseLang) && kw.some(k => v.name.toLowerCase().includes(k)));
  if (!v) v = voices.find(v => v.lang.startsWith(baseLang));
  if (!v) v = voices.find(v => v.lang === 'en-US' && kw.some(k => v.name.toLowerCase().includes(k)));
  if (!v) v = voices.find(v => v.lang === 'en-US');
  if (!v) v = voices[0];

  _cachedVoice   = v;
  _cachedProfile = profile;
  _cachedLang    = targetLang;

  Logger.info(`[TTS] Selected voice: "${v?.name}" (${v?.lang}) for locale ${targetLang}`);
  return { voice: v, profile };
}

// Pre-load voices on module init
function preloadVoices() {
  if (!window.speechSynthesis) return;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) {
    window.speechSynthesis.onvoiceschanged = () => {
      // invalidate cache on voice list update
      _cachedVoice = null;
      _cachedLang  = null;
    };
  }
}

/**
 * Speak a message in the user's selected language.
 * Called ONLY from handleAudioUpload (post-recording).
 *
 * @param {string} text - The message to speak
 * @param {string} [lang] - BCP-47 language code. Defaults to navigator.language
 */
export function speakText(text, lang) {
  if (!window.speechSynthesis) return;

  // Resolve language: explicit > settingsStore > navigator
  let targetLang = lang;
  if (!targetLang) {
    try {
      // Dynamically read from settingsStore without circular dependency
      const stored = localStorage.getItem('vroomie_settings_v1');
      if (stored) {
        const parsed = JSON.parse(stored);
        targetLang = parsed.language || navigator.language || 'en-US';
      }
    } catch { /* ignore */ }
  }
  targetLang = targetLang || navigator.language || 'en-US';

  window.speechSynthesis.cancel(); // cancel any in-flight utterance

  const { voice, profile } = selectVoice(targetLang);

  const u = new SpeechSynthesisUtterance(text);
  if (voice)   { u.voice = voice; u.lang = voice.lang; }
  else         { u.lang = targetLang; }
  u.pitch = profile?.pitch ?? 1.0;
  u.rate  = profile?.rate  ?? 1.0;

  Logger.info(`[TTS] Speaking in ${u.lang}: "${text.substring(0, 60)}..."`);
  window.speechSynthesis.speak(u);
}

/**
 * Build a natural-sounding summary and speak it.
 * Called from AudioRecorder after recording stops.
 */
export function speakScanResult(anomalies, lang) {
  if (!window.speechSynthesis) return;

  const t = TRANSLATIONS[lang] || DEFAULT_PHRASES;

  let message;
  if (!anomalies || anomalies.length === 0) {
    message = [t.scanComplete, t.noAnomaly].join(' ');
  } else {
    const names = [...new Set(anomalies.map(a => a.type))].join(', ');
    message = [t.scanComplete, t.issueDetected, names + '.', t.visitWorkshop].join(' ');
  }

  speakText(message, lang);
}

/**
 * DISABLED STUB — real-time TTS during recording is prohibited.
 * Kept for import compatibility only.
 */
export function triggerContinuousAlert(_rawLabel, _voiceEnabled) {
  // Intentionally empty — all voice output is post-recording.
}

/**
 * Cancel any in-flight speech (called when recording starts).
 */
export function clearContinuousAlert() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

preloadVoices();
