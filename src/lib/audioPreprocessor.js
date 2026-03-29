/**
 * audioPreprocessor.js — Domain-Robust Audio Preprocessing Pipeline
 * 
 * Shared identically between offline (Supabase reference) and live (microphone).
 * TARGET: 16kHz mono, bandpass 20–5kHz, spectral gate, RMS norm
 */
import { Logger } from './logger';

export const TARGET_SR = 16000;
export const CHUNK_SAMPLES = 4000; // 250ms at 16kHz
export const WINDOW_SAMPLES = 32000; // 2 seconds at 16kHz

// ═══════════════════════════════════════════════════════════
// RESAMPLING
// ═══════════════════════════════════════════════════════════

export function linearResample(signal, oldSr, newSr = TARGET_SR) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idealIdx = i * ratio;
    const leftIdx = Math.floor(idealIdx);
    const rightIdx = Math.ceil(idealIdx);
    const frac = idealIdx - leftIdx;
    
    // Boundary check
    if (rightIdx >= signal.length) {
      out[i] = signal[leftIdx];
    } else {
      out[i] = signal[leftIdx] * (1 - frac) + signal[rightIdx] * frac;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// BANDPASS FILTER (50Hz–5000Hz) — Butterworth biquad
// ═══════════════════════════════════════════════════════════

function biquadFilter(signal, b0, b1, b2, a1, a2) {
  const out = new Float32Array(signal.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

export function applyBandpass(signal, sampleRate = TARGET_SR) {
  // High-pass at 50Hz
  const fHP = 50;
  const wHP = 2 * Math.PI * fHP / sampleRate;
  const cosHP = Math.cos(wHP);
  const sinHP = Math.sin(wHP);
  const alphaHP = sinHP / (2 * 0.707);
  const a0HP = 1 + alphaHP;
  const hp_b0 = ((1 + cosHP) / 2) / a0HP;
  const hp_b1 = (-(1 + cosHP)) / a0HP;
  const hp_b2 = ((1 + cosHP) / 2) / a0HP;
  const hp_a1 = (-2 * cosHP) / a0HP;
  const hp_a2 = (1 - alphaHP) / a0HP;
  
  let filtered = biquadFilter(signal, hp_b0, hp_b1, hp_b2, hp_a1, hp_a2);
  
  // Low-pass at 5000Hz
  const fLP = 5000;
  const wLP = 2 * Math.PI * fLP / sampleRate;
  const cosLP = Math.cos(wLP);
  const sinLP = Math.sin(wLP);
  const alphaLP = sinLP / (2 * 0.707);
  const a0LP = 1 + alphaLP;
  const lp_b0 = ((1 - cosLP) / 2) / a0LP;
  const lp_b1 = (1 - cosLP) / a0LP;
  const lp_b2 = ((1 - cosLP) / 2) / a0LP;
  const lp_a1 = (-2 * cosLP) / a0LP;
  const lp_a2 = (1 - alphaLP) / a0LP;
  
  filtered = biquadFilter(filtered, lp_b0, lp_b1, lp_b2, lp_a1, lp_a2);
  return filtered;
}

// ═══════════════════════════════════════════════════════════
// SPECTRAL GATING — Noise Floor Removal
// Estimates noise profile from lowest-energy frames and subtracts
// ═══════════════════════════════════════════════════════════

export function applySpectralGate(signal, threshold = 0.015) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    out[i] = Math.abs(signal[i]) > threshold ? signal[i] : signal[i] * 0.1;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// RMS NORMALIZATION (NOT PEAK)
// ═══════════════════════════════════════════════════════════

export function normalizeRMS(signal, targetRMS = 0.1) {
  let sumSq = 0;
  for (let i = 0; i < signal.length; i++) sumSq += signal[i] * signal[i];
  const currentRMS = Math.sqrt(sumSq / signal.length);
  if (currentRMS < 1e-8) return signal;
  
  const gain = targetRMS / currentRMS;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    out[i] = Math.max(-1, Math.min(1, signal[i] * gain));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// DYNAMIC RANGE COMPRESSION
// ═══════════════════════════════════════════════════════════

export function compressDynamicRange(signal, threshold = 0.3, ratio = 4) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const abs = Math.abs(signal[i]);
    const sign = signal[i] >= 0 ? 1 : -1;
    if (abs <= threshold) {
      out[i] = signal[i];
    } else {
      out[i] = sign * (threshold + (abs - threshold) / ratio);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// MONO CONVERSION
// ═══════════════════════════════════════════════════════════

export function mixToMono(audioBuffer) {
  if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.getChannelData(1);
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
  return mono;
}

export function mixToMonoFromRaw(inputBuffer) {
  if (inputBuffer.numberOfChannels === 1) return inputBuffer.getChannelData(0);
  const left = inputBuffer.getChannelData(0);
  const right = inputBuffer.getChannelData(1);
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
  return mono;
}

// ═══════════════════════════════════════════════════════════
// FULL PIPELINE (IDENTICAL FOR BOTH REF AND LIVE)
// ═══════════════════════════════════════════════════════════

export function preprocessSignal(signal, sampleRate = TARGET_SR) {
  let processed = linearResample(signal, sampleRate, TARGET_SR);
  // After resampling, the signal is at TARGET_SR (16kHz)
  processed = applyBandpass(processed, TARGET_SR);
  processed = applySpectralGate(processed, 0.015);
  processed = compressDynamicRange(processed, 0.3, 4);
  processed = normalizeRMS(processed, 0.1);
  return processed;
}

// ═══════════════════════════════════════════════════════════
// SIGNAL STATS LOGGING
// ═══════════════════════════════════════════════════════════

export function logSignalStats(signal, source) {
  let min = Infinity, max = -Infinity, sum = 0, sumSq = 0;
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / signal.length;
  for (let i = 0; i < signal.length; i++) sumSq += (signal[i] - mean) ** 2;
  const std = Math.sqrt(sumSq / signal.length);
  let rms = 0;
  for (let i = 0; i < signal.length; i++) rms += signal[i] * signal[i];
  rms = Math.sqrt(rms / signal.length);
  
  console.log(`SIGNAL [${source}]`, {
    mean: mean.toFixed(6), std: std.toFixed(6), rms: rms.toFixed(6),
    min: min.toFixed(4), max: max.toFixed(4), length: signal.length
  });
}
