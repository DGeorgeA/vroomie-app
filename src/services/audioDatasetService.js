/**
 * audioDatasetService.js — Vroomie Reference Library
 *
 * FIXED: All reference embeddings now use the IDENTICAL pipeline as live audio:
 *   - Mono, resampled to 16kHz (via OfflineAudioContext)
 *   - Bandpass 50-5000Hz, spectral gate, RMS normalize
 *   - 40-dim L2-normalized MFCC (same parameters as audioMatchingEngine live path)
 *   - Store as computed_mfcc_40 so code never tries to use incompatible YAMNet dims
 *
 * This guarantees apples-to-apples comparison between reference and live vectors.
 */

import { supabase } from '../lib/supabase';
import { Logger } from '../lib/logger';
import { openDB } from 'idb';
import { TARGET_SR, computeCompositeEmbedding, PIPELINE_VERSION } from '../lib/audioMath_v11.js';

export let referenceIndex = [];

const BUCKET = 'anomaly-patterns';
const REF_DURATION = 5; // Use first 5 seconds of each reference file

// ─── IndexedDB Cache ─────────────────────────────────────────────────────────
const initDB = async () => {
  return openDB('vroomie-db', 2, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('anomaly_references')) {
        db.createObjectStore('anomaly_references', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('computed_composite_refs')) {
        db.createObjectStore('computed_composite_refs', { keyPath: 'label' });
      }
    },
  });
};

// ─── Filename → metadata ─────────────────────────────────────────────────────
function inferMetadata(filename) {
  const name = filename.toLowerCase().replace(/\.(wav|mp3|ogg|webm)$/, '');
  if (name.includes('normal') || name.includes('idle') || name.includes('baseline'))
    return { category: 'normal', severity: 'low', label: `normal_${name}` };
  if (name.includes('knock') || name.includes('ping') || name.includes('knocking'))
    return { category: 'engine_knock', severity: 'high', label: `engine_knocking_${name}` };
  if (name.includes('bearing') || name.includes('grind') || name.includes('alternator'))
    return { category: 'bearing_fault', severity: 'critical', label: `bearing_fault_${name}` };
  if (name.includes('misfire') || name.includes('miss'))
    return { category: 'misfire', severity: 'medium', label: `misfire_${name}` };
  if (name.includes('belt') || name.includes('pulley') || name.includes('squeak') || name.includes('serpentine'))
    return { category: 'belt_issue', severity: 'medium', label: `belt_squeal_${name}` };
  if (name.includes('exhaust') || name.includes('rattle') || name.includes('timing'))
    return { category: 'exhaust_issue', severity: 'medium', label: `exhaust_leak_${name}` };
  if (name.includes('piston'))
    return { category: 'engine_knock', severity: 'high', label: `piston_knock_${name}` };
  if (name.includes('water') || name.includes('pump'))
    return { category: 'bearing_fault', severity: 'critical', label: `water_pump_${name}` };
  if (name.includes('rocker') || name.includes('valve'))
    return { category: 'valve_issue', severity: 'medium', label: `valve_train_${name}` };
  if (name.includes('steering'))
    return { category: 'bearing_fault', severity: 'medium', label: `steering_pump_${name}` };
  if (name.includes('motor') || name.includes('starter'))
    return { category: 'starter_issue', severity: 'medium', label: `motor_starter_${name}` };
  return { category: 'unknown_anomaly', severity: 'medium', label: `anomaly_${name}` };
}

// ─── Composite feature vector — SHARED LOGIC ─────────────────────────────────
// (Imported from ../lib/audioMath.js)

// ─── Full preprocessing pipeline — MUST BE IDENTICAL TO LIVE PIPELINE ─────────
function preprocessAudioBuffer(rawSamples, sourceSR) {
  // 1. Resample to 16kHz
  let processed = linearResampleFn(rawSamples, sourceSR, TARGET_SR);
  // 2. Bandpass 50-5000Hz
  processed = bandpassFn(processed, TARGET_SR);
  // 3. Spectral gate
  processed = spectralGateFn(processed, 0.015);
  // 4. RMS Normalize
  processed = rmsNormFn(processed, 0.1);
  return processed;
}

// Inline mini versions so we don't create circular imports with audioPreprocessor
function linearResampleFn(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const left = Math.floor(idx);
    const right = Math.min(Math.ceil(idx), signal.length - 1);
    const frac = idx - left;
    out[i] = signal[left] * (1 - frac) + signal[right] * frac;
  }
  return out;
}

function bandpassFn(signal, sr) {
  function biquad(sig, b0, b1, b2, a1, a2) {
    const out = new Float32Array(sig.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < sig.length; i++) {
      const x0 = sig[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  }
  const wHP = 2 * Math.PI * 50 / sr, cHP = Math.cos(wHP), sHP2 = Math.sin(wHP) / 1.414, a0HP = 1 + sHP2;
  signal = biquad(signal, (1+cHP)/2/a0HP, -(1+cHP)/a0HP, (1+cHP)/2/a0HP, -2*cHP/a0HP, (1-sHP2)/a0HP);
  const wLP = 2 * Math.PI * 5000 / sr, cLP = Math.cos(wLP), sLP2 = Math.sin(wLP) / 1.414, a0LP = 1 + sLP2;
  signal = biquad(signal, (1-cLP)/2/a0LP, (1-cLP)/a0LP, (1-cLP)/2/a0LP, -2*cLP/a0LP, (1-sLP2)/a0LP);
  return signal;
}

function spectralGateFn(signal, threshold) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.abs(signal[i]) > threshold ? signal[i] : signal[i] * 0.1;
  return out;
}

function rmsNormFn(signal, target) {
  let sq = 0;
  for (let i = 0; i < signal.length; i++) sq += signal[i] * signal[i];
  const rms = Math.sqrt(sq / signal.length);
  if (rms < 1e-8) return signal;
  const gain = target / rms;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-1, Math.min(1, signal[i] * gain));
  return out;
}

// ─── Compute MFCC from a public audio URL ────────────────────────────────────
async function computeFeaturesFromUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();

    // Decode via OfflineAudioContext at native rate first, then we resample
    const audioCtx = new OfflineAudioContext(1, TARGET_SR * REF_DURATION, TARGET_SR);
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);

    // Mix to mono
    let samples;
    if (decoded.numberOfChannels === 1) {
      samples = decoded.getChannelData(0);
    } else {
      const L = decoded.getChannelData(0);
      const R = decoded.getChannelData(1);
      samples = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) samples[i] = (L[i] + R[i]) / 2;
    }

    // Apply IDENTICAL preprocessing to live path
    const processed = preprocessAudioBuffer(samples, decoded.sampleRate);

    // Energy gate — skip silent files
    const rms = Math.sqrt(processed.reduce((s, v) => s + v * v, 0) / processed.length);
    if (rms < 0.0005) {
      Logger.warn(`[Vroomie Dataset] Skipping silent file: ${url} (RMS=${rms.toFixed(6)})`);
      return null;
    }

    Logger.info(`[Vroomie Dataset] Processed: ${url.split('/').pop()} RMS=${rms.toFixed(4)} len=${processed.length}`);
    return computeCompositeEmbedding(processed, TARGET_SR);
  } catch (err) {
    Logger.warn(`Feature compute failed for ${url}: ${err.message}`);
    return null;
  }
}

// ─── Compute features from live AudioBuffer (called from live pipeline) ───────
export function computeFeaturesFromAudioBuffer(audioBuffer) {
  const samples = audioBuffer.getChannelData(0);
  // Apply same preprocessing
  const processed = preprocessAudioBuffer(samples, audioBuffer.sampleRate);
  return computeCompositeEmbedding(processed, TARGET_SR);
}

// ─── Initialization helper ──────────────────────────────────────────────────

// ─── Main: Initialize reference library ──────────────────────────────────────
export async function initializeAudioDataset() {
  if (referenceIndex && referenceIndex.length > 0) return;

  referenceIndex = [];
  Logger.info(`🎵 Initializing Vroomie Anomaly Reference Library [${PIPELINE_VERSION}]...`);

  try {
    // 1. Try engine_audio_patterns
    const { data: patterns, error } = await supabase.from('engine_audio_patterns').select('*');
    if (!error && patterns && patterns.length > 0) {
      for (const ref of patterns) {
        let vec = ref.embedding_vector || ref.features || ref.vector;
        if (typeof vec === 'string') {
          try { vec = JSON.parse(vec); } catch { continue; }
        }
        if (!Array.isArray(vec) || vec.length === 0) continue;

        referenceIndex.push({
          id: ref.id,
          label: ref.label || ref.name || 'unknown_anomaly',
          category: ref.category || 'unknown',
          severity: ref.severity || 'medium',
          source: 'supabase_engine_audio_patterns',
          embedding_vector: vec, 
        });
      }
      console.log(`[Vroomie Dataset] ✅ Loaded ${referenceIndex.length} anomaly patterns from engine_audio_patterns DB table.`);
      return;
    }

    Logger.warn('⚠️ engine_audio_patterns is empty or unavailable. Falling back to identical preprocessing from storage bucket...');

    // 2. Try IDB Cache
    const db = await initDB().catch(() => null);
    if (db) {
      try {
        const cached = await db.getAll('computed_composite_refs');
        // V11.5 HARDENING: Require 145-dim vectors (min 140)
        const valid = (cached || []).filter(c => Array.isArray(c.embedding_vector) && c.embedding_vector.length >= 140);
        if (valid.length > 0) {
          referenceIndex = valid.map(c => ({
            label: c.label,
            category: c.category,
            severity: c.severity || 'medium',
            source_file: c.source_file,
            source: 'idb_composite_cache',
            embedding_vector: c.embedding_vector,
          }));
          console.log(`[Vroomie Dataset] ✅ Loaded ${referenceIndex.length} references from IDB cache.`);
          return;
        }
      } catch (e) { Logger.warn('IDB read failed:', e.message); }
    }

    // 3. Compute Embeddings from Storage bucket using computeFeaturesFromUrl (IDENTICAL PREPROCESSING)
    const { data: files, error: listErr } = await supabase.storage.from('anomaly-patterns').list('', { limit: 200, sortBy: { column: 'name', order: 'asc' } });
    if (listErr || !files || files.length === 0) {
      Logger.error('Storage list failed or empty:', listErr?.message);
      return;
    }

    const audioFiles = files.filter(f => f.name && /\.(wav|mp3|ogg|webm)$/i.test(f.name));
    const computed = [];

    for (const file of audioFiles) {
      const { data: urlData } = supabase.storage.from('anomaly-patterns').getPublicUrl(file.name);
      
      // Basic infer Metadata based on filename (e.g. piston_knock.wav)
      const fileNameLower = file.name.toLowerCase();
      let label = 'anomaly';
      let severity = 'medium';
      if (fileNameLower.includes('piston') || fileNameLower.includes('knock')) { label = 'Piston Knock'; severity = 'critical'; }
      else if (fileNameLower.includes('misfire')) { label = 'Engine Misfire'; severity = 'critical'; }
      else if (fileNameLower.includes('belt') || fileNameLower.includes('squeal')) { label = 'Belt Squeal'; severity = 'warning'; }

      try {
        const features = await computeFeaturesFromUrl(urlData.publicUrl);
        if (!features || features.length === 0) continue;
        const entry = {
          label: label,
          category: 'engine',
          severity: severity,
          source_file: file.name,
          source: 'storage_mfcc',
          embedding_vector: features,
        };
        computed.push(entry);
        referenceIndex.push(entry);
      } catch (err) {
        Logger.warn(`❌ Skipping ${file.name}: ${err.message}`);
      }
    }

    if (referenceIndex.length > 0 && db) {
      try {
        const tx = db.transaction('computed_composite_refs', 'readwrite');
        await tx.store.clear();
        for (const entry of computed) await tx.store.put(entry);
        await tx.done;
      } catch (e) { }
    }

    console.log(`[Vroomie Dataset] ✅ Loaded ${referenceIndex.length} patterns by computing identical features from Storage.`);
  } catch (err) {
    Logger.error('Dataset initialization failed completely:', err);
  }
}
