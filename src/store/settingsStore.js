/**
 * settingsStore.js — Vroomie User Settings
 *
 * Single source of truth for all user preferences.
 * Persists to localStorage immediately and syncs to Supabase when logged in.
 * Exposes live setters that directly mutate pipeline configuration.
 */

import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import { setDetectionMode, getDetectionMode } from '../lib/detectionMode';

// ─── Persistence keys ─────────────────────────────────────────────────────────
const STORAGE_KEY = 'vroomie_settings_v1';

// ─── Sensitivity → threshold mappings ────────────────────────────────────────
// These are the actual ANOMALY_THRESHOLD overrides applied to audioMatchingEngine
export const SENSITIVITY_CONFIG = {
  low:    { anomalyThreshold: 0.75, probableThreshold: 0.62, rmsGate: 0.015 },
  medium: { anomalyThreshold: 0.65, probableThreshold: 0.50, rmsGate: 0.008 },
  high:   { anomalyThreshold: 0.55, probableThreshold: 0.40, rmsGate: 0.005 },
};

// ─── Language options ─────────────────────────────────────────────────────────
export const LANGUAGE_OPTIONS = [
  { code: 'en-US', name: 'English (US)' },
  { code: 'en-IN', name: 'English (India)' },
  { code: 'hi-IN', name: 'Hindi' },
  { code: 'ta-IN', name: 'Tamil' },
  { code: 'te-IN', name: 'Telugu' },
  { code: 'kn-IN', name: 'Kannada' },
];

// ─── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  language: 'en-US',
  voiceAlertsEnabled: true,
  sensitivity: 'medium',      // 'low' | 'medium' | 'high'
  detectionMode: 'basic',     // 'basic' | 'ml'
  saveHistory: true,
  dataCollectionEnabled: true,
};

// ─── LocalStorage helpers ──────────────────────────────────────────────────────
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveToStorage(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* private/storage-full — ignore */ }
}

// ─── Supabase sync ─────────────────────────────────────────────────────────────
async function syncToSupabase(userId, settings) {
  if (!userId) return;
  try {
    await supabase
      .from('user_preferences')
      .upsert(
        { user_id: userId, preferences: settings, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
  } catch { /* table may not exist yet — degrade gracefully */ }
}

async function loadFromSupabase(userId) {
  if (!userId) return null;
  try {
    const { data } = await supabase
      .from('user_preferences')
      .select('preferences')
      .eq('user_id', userId)
      .maybeSingle();
    return data?.preferences || null;
  } catch {
    return null;
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────
const initialSettings = loadFromStorage();

// Apply detection mode from persisted state back to the pipeline singleton
if (initialSettings.detectionMode) {
  setDetectionMode(initialSettings.detectionMode);
}

export const useSettingsStore = create((set, get) => ({
  ...initialSettings,
  _userId: null,

  // Called after auth resolves — loads from Supabase and merges
  async hydrate(userId) {
    set({ _userId: userId });
    if (!userId) return;
    const remote = await loadFromSupabase(userId);
    if (remote) {
      const merged = { ...DEFAULT_SETTINGS, ...loadFromStorage(), ...remote };
      set(merged);
      saveToStorage(merged);
      // Re-apply pipeline settings
      if (merged.detectionMode) setDetectionMode(merged.detectionMode);
    }
  },

  // ── Language ──────────────────────────────────────────────────────────────
  setLanguage(lang) {
    const s = get();
    const next = { ...s, language: lang };
    set({ language: lang });
    saveToStorage(next);
    syncToSupabase(s._userId, next);
  },

  // ── Voice Alerts ──────────────────────────────────────────────────────────
  setVoiceAlerts(enabled) {
    const s = get();
    const next = { ...s, voiceAlertsEnabled: enabled };
    set({ voiceAlertsEnabled: enabled });
    saveToStorage(next);
    syncToSupabase(s._userId, next);
  },

  // ── Sensitivity — directly updates matching engine thresholds ─────────────
  setSensitivity(level) {
    const s = get();
    const cfg = SENSITIVITY_CONFIG[level];
    if (!cfg) return;

    // Mutate audioMatchingEngine module-level threshold overrides
    // (imported lazily to avoid circular deps at store init time)
    import('../lib/audioMatchingEngine').then(mod => {
      if (mod.applyThresholdOverride) mod.applyThresholdOverride(cfg);
    });

    const next = { ...s, sensitivity: level };
    set({ sensitivity: level });
    saveToStorage(next);
    syncToSupabase(s._userId, next);
  },

  // ── Detection Mode — wires directly to detectionMode.js singleton ─────────
  setDetectionMode(mode) {
    const s = get();
    setDetectionMode(mode); // live effect on pipeline
    const next = { ...s, detectionMode: mode };
    set({ detectionMode: mode });
    saveToStorage(next);
    syncToSupabase(s._userId, next);
  },

  // ── Save History ──────────────────────────────────────────────────────────
  setSaveHistory(enabled) {
    const s = get();
    const next = { ...s, saveHistory: enabled };
    set({ saveHistory: enabled });
    saveToStorage(next);
    syncToSupabase(s._userId, next);
  },

  // ── Data Collection ───────────────────────────────────────────────────────
  setDataCollection(enabled) {
    const s = get();
    const next = { ...s, dataCollectionEnabled: enabled };
    set({ dataCollectionEnabled: enabled });
    saveToStorage(next);
    syncToSupabase(s._userId, next);
  },
}));
