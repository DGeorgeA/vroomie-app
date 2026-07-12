/**
 * motionDetector.js — vehicle-presence check via device motion sensors.
 *
 * A running engine vibrates the vehicle body; a phone held in or resting on a
 * running vehicle picks up sustained micro-vibration on the accelerometer
 * (idle ≈ 0.05–0.3 m/s² high-passed). A phone on a couch in front of a TV
 * measures ≈ 0.001–0.01 m/s². This signal gates ANOMALY reporting only:
 * an anomaly is published only when vehicle vibration was sensed alongside it.
 *
 * FAIL-OPEN by design: desktops without sensors, browsers without
 * DeviceMotion, and users who deny the iOS motion permission are treated as
 * "verification unavailable" and reports proceed exactly as before. The gate
 * can only ever suppress an anomaly on a device that demonstrably measured
 * total stillness for the whole session.
 */
import { Logger } from './logger.js';

// High-passed RMS above this (m/s²) counts as vehicle/handheld vibration.
// Handheld tremor alone (~0.05–0.2 m/s²) passes — a hand-held phone is never
// "perfectly still", so only set-down-in-a-quiet-room sessions are suppressed.
const VIBRATION_RMS_THRESHOLD = 0.03;
// Need at least ~2 s of sensor data before claiming the device was still.
const MIN_SAMPLES_FOR_VERDICT = 60;

/**
 * Pure classifier — unit-testable without a browser.
 * @param {Array<{x:number,y:number,z:number}>} samples accelerationIncludingGravity readings
 * @returns {{verdict:'moving'|'still'|'insufficient', vibrationRms:number, samples:number}}
 */
export function classifyMotionSamples(samples) {
  if (!samples || samples.length < MIN_SAMPLES_FOR_VERDICT) {
    return { verdict: 'insufficient', vibrationRms: 0, samples: samples ? samples.length : 0 };
  }
  // One-pole high-pass per axis removes gravity/orientation; RMS of the
  // residual measures vibration + movement.
  let hx = samples[0].x, hy = samples[0].y, hz = samples[0].z;
  let sumSq = 0, n = 0;
  const alpha = 0.9;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    hx = alpha * hx + (1 - alpha) * s.x;
    hy = alpha * hy + (1 - alpha) * s.y;
    hz = alpha * hz + (1 - alpha) * s.z;
    const dx = s.x - hx, dy = s.y - hy, dz = s.z - hz;
    sumSq += dx * dx + dy * dy + dz * dz;
    n++;
  }
  const vibrationRms = Math.sqrt(sumSq / Math.max(1, n));
  return {
    verdict: vibrationRms >= VIBRATION_RMS_THRESHOLD ? 'moving' : 'still',
    vibrationRms,
    samples: samples.length
  };
}

// ─── Browser session wrapper ─────────────────────────────────────────────────
let _samples = [];
let _listening = false;
let _permission = 'unknown'; // 'granted' | 'denied' | 'unsupported' | 'unknown'

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (a && a.x != null && a.y != null && a.z != null) {
    _samples.push({ x: a.x, y: a.y, z: a.z });
    if (_samples.length > 4000) _samples.shift(); // cap memory (~2 min @30Hz)
  }
}

/**
 * Start sampling. Must be called from a user gesture (iOS permission prompt).
 * Never throws — resolves with the permission state.
 */
export async function startMotionCapture() {
  _samples = [];
  if (typeof window === 'undefined' || typeof window.DeviceMotionEvent === 'undefined') {
    _permission = 'unsupported';
    return _permission;
  }
  try {
    if (typeof window.DeviceMotionEvent.requestPermission === 'function') {
      // iOS 13+ — requires user-gesture context
      const res = await window.DeviceMotionEvent.requestPermission();
      _permission = res === 'granted' ? 'granted' : 'denied';
      if (_permission !== 'granted') return _permission;
    } else {
      _permission = 'granted';
    }
    window.addEventListener('devicemotion', onMotion);
    _listening = true;
  } catch (err) {
    Logger.warn('Motion capture unavailable:', err?.message);
    _permission = 'unsupported';
  }
  return _permission;
}

/**
 * Stop sampling and classify the session.
 * @returns {{available:boolean, verdict:string, vibrationRms:number, samples:number}}
 */
export function stopMotionCapture() {
  if (_listening) {
    window.removeEventListener('devicemotion', onMotion);
    _listening = false;
  }
  if (_permission !== 'granted') {
    return { available: false, verdict: 'unavailable', vibrationRms: 0, samples: 0 };
  }
  const result = classifyMotionSamples(_samples);
  // Sensors "granted" but no events ever fired (common on laptops) — fail open
  const available = result.verdict !== 'insufficient';
  Logger.info(`[Motion] verdict=${result.verdict} rms=${result.vibrationRms.toFixed(4)} samples=${result.samples}`);
  return { available, ...result };
}
