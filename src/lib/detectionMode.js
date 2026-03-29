/**
 * Detection Mode State Manager
 * Controls whether the system uses ML (CNN) or Basic (Meyda) detection.
 * Provides event-based switching for clean pipeline separation.
 */
import { Logger } from './logger';

// ─── State ────────────────────────────────────────────────
let detectionMode = 'basic'; // 'ml' or 'basic'
const listeners = new Set();

// ─── API ──────────────────────────────────────────────────

/**
 * Get the current detection mode.
 * @returns {'ml' | 'basic'}
 */
export function getDetectionMode() {
  return detectionMode;
}

/**
 * Set the detection mode.
 * @param {'ml' | 'basic'} mode
 */
export function setDetectionMode(mode) {
  if (mode !== 'ml' && mode !== 'basic') {
    Logger.warn(`Invalid detection mode: ${mode}, ignoring`);
    return;
  }
  
  if (mode === detectionMode) return;
  
  const prev = detectionMode;
  detectionMode = mode;
  
  Logger.info(`Detection mode switched: ${prev} → ${mode}`);
  
  // Notify all listeners
  for (const listener of listeners) {
    try {
      listener(mode, prev);
    } catch (e) {
      Logger.error('Detection mode listener error', e);
    }
  }
}

/**
 * Subscribe to mode changes.
 * @param {(newMode: string, prevMode: string) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onModeChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Check if current mode is ML.
 */
export function isMLMode() {
  return detectionMode === 'ml';
}

/**
 * Check if current mode is Basic.
 */
export function isBasicMode() {
  return detectionMode === 'basic';
}
