/**
 * audioDatasetService.js — Vroomie Reference Library v12.0
 *
 * CRITICAL FIXES IN v12:
 *   1. IDB key is now source_file (unique per file) — NOT label (was causing overwrites)
 *   2. Cache version bumped to 3 (clears stale v11 data with wrong keys)
 *   3. Spectral flatness gate removed from matching (vehicle sounds rejected erroneously)
 *   4. Richer label inference from filenames
 *   5. Forced re-fetch from bucket if referenceIndex is empty even after IDB check
 *   6. Debug logging to confirm how many references loaded
 *
 * Preprocessing pipeline (IDENTICAL to featureWorker.js live path):
 *   - Mono mix
 *   - Resample to 16kHz (OfflineAudioContext native decode at 16kHz)
 *   - Bandpass 50–5kHz
 *   - Spectral gate
 *   - RMS normalize to 0.1
 *   - 145-dim composite embedding (Log-Mel64 mean+SD + MFCC13 + SF + 3 stats)
 *   - L2 normalize
 */

import { supabase } from '../lib/supabase';
import { Logger } from '../lib/logger';
import { openDB } from 'idb';
import { TARGET_SR, computeCompositeEmbedding, PIPELINE_VERSION } from '../lib/audioMath_v11.js';

export let referenceIndex = [];

const BUCKET = 'anomaly-patterns';
const REF_DURATION = 5; // seconds to take from each reference file
const IDB_VERSION  = 3; // bump to invalidate stale caches from v11
const IDB_STORE    = 'composite_refs_v12'; // new store name — old store left behind, ignored

// ─── IndexedDB Cache ─────────────────────────────────────────────────────────
const initDB = async () => {
  return openDB('vroomie-db', IDB_VERSION, {
    upgrade(db, oldVersion) {
      // Always ensure the new v12 store exists
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'source_file' });
      }
    },
  });
};

// ─── Filename → metadata ─────────────────────────────────────────────────────
function inferMetadata(filename) {
  const name = filename.toLowerCase().replace(/\.(wav|mp3|ogg|webm|flac|m4a)$/, '');

  if (name.includes('normal')   || name.includes('idle')    || name.includes('baseline'))
    return { category: 'normal',        severity: 'low',      label: 'Normal / Idle Engine' };
  if (name.includes('piston')   || name.includes('knock')   || name.includes('ping') || name.includes('knocking'))
    return { category: 'engine_knock',  severity: 'critical', label: 'Piston Knock' };
  if (name.includes('bearing')  || name.includes('grind')   || name.includes('alternator'))
    return { category: 'bearing_fault', severity: 'critical', label: 'Bearing Fault' };
  if (name.includes('misfire')  || name.includes('miss'))
    return { category: 'misfire',       severity: 'high',     label: 'Engine Misfire' };
  if (name.includes('belt')     || name.includes('squeal')  || name.includes('serpentine') || name.includes('pulley'))
    return { category: 'belt_issue',    severity: 'high',     label: 'Belt Squeal' };
  if (name.includes('exhaust')  || name.includes('rattle'))
    return { category: 'exhaust_issue', severity: 'medium',   label: 'Exhaust Rattle' };
  if (name.includes('timing'))
    return { category: 'timing_issue',  severity: 'critical', label: 'Timing Issue' };
  if (name.includes('water')    || name.includes('pump'))
    return { category: 'bearing_fault', severity: 'critical', label: 'Water Pump Fault' };
  if (name.includes('rocker')   || name.includes('valve') || name.includes('tappet'))
    return { category: 'valve_issue',   severity: 'high',     label: 'Valve Train Noise' };
  if (name.includes('steering'))
    return { category: 'bearing_fault', severity: 'medium',   label: 'Steering Pump Noise' };
  if (name.includes('motor')    || name.includes('starter'))
    return { category: 'starter_issue', severity: 'medium',   label: 'Starter Motor Fault' };
  if (name.includes('coolant')  || name.includes('fan'))
    return { category: 'cooling_issue', severity: 'medium',   label: 'Cooling Fan Noise' };

  // Fallback: use cleaned filename as label
  const prettyName = name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { category: 'unknown_anomaly', severity: 'medium', label: prettyName };
}

// ─── Inline preprocessing — MUST BE IDENTICAL TO featureWorker.js ─────────────
function linearResampleFn(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio  = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out    = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx   = i * ratio;
    const left  = Math.floor(idx);
    const right = Math.min(left + 1, signal.length - 1);
    const frac  = idx - left;
    out[i] = signal[left] * (1 - frac) + signal[right] * frac;
  }
  return out;
}

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

function bandpassFn(signal, sr) {
  const wHP = 2 * Math.PI * 50 / sr, cHP = Math.cos(wHP), sHP = Math.sin(wHP) / 1.414, a0HP = 1 + sHP;
  signal = biquad(signal, (1 + cHP) / 2 / a0HP, -(1 + cHP) / a0HP, (1 + cHP) / 2 / a0HP, -2 * cHP / a0HP, (1 - sHP) / a0HP);
  const wLP = 2 * Math.PI * 5000 / sr, cLP = Math.cos(wLP), sLP = Math.sin(wLP) / 1.414, a0LP = 1 + sLP;
  signal = biquad(signal, (1 - cLP) / 2 / a0LP, (1 - cLP) / a0LP, (1 - cLP) / 2 / a0LP, -2 * cLP / a0LP, (1 - sLP) / a0LP);
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
  const out  = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-1, Math.min(1, signal[i] * gain));
  return out;
}

function preprocessAudioBuffer(samples, sourceSR) {
  let processed = linearResampleFn(samples, sourceSR, TARGET_SR);
  processed = bandpassFn(processed, TARGET_SR);
  processed = spectralGateFn(processed, 0.015);
  processed = rmsNormFn(processed, 0.1);
  return processed;
}

// ─── Compute embedding from a public audio URL ────────────────────────────────
async function computeFeaturesFromUrl(url, filename) {
  try {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    const arrayBuffer = await response.arrayBuffer();

    // Decode at NATIVE rate (let the browser do quality resampling)
    const nativeCtx = new OfflineAudioContext(1, 1, 44100);
    const decoded   = await nativeCtx.decodeAudioData(arrayBuffer);
    const nativeSR  = decoded.sampleRate;

    // Mix to mono
    let samples;
    if (decoded.numberOfChannels === 1) {
      samples = decoded.getChannelData(0).slice();
    } else {
      const L = decoded.getChannelData(0);
      const R = decoded.getChannelData(1);
      samples = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) samples[i] = (L[i] + R[i]) / 2;
    }

    // Trim to REF_DURATION seconds at native SR
    const maxSamples = Math.min(samples.length, nativeSR * REF_DURATION);
    samples = samples.slice(0, maxSamples);

    // Apply full preprocessing pipeline
    const processed = preprocessAudioBuffer(samples, nativeSR);

    // Silence gate
    let sq = 0;
    for (let i = 0; i < processed.length; i++) sq += processed[i] * processed[i];
    const rms = Math.sqrt(sq / processed.length);
    if (rms < 0.0005) {
      Logger.warn(`[Dataset] Skipping silent file: ${filename} (RMS=${rms.toFixed(6)})`);
      return null;
    }

    const embedding = computeCompositeEmbedding(processed, TARGET_SR);
    Logger.info(`[Dataset] ✅ ${filename}: RMS=${rms.toFixed(4)}, len=${processed.length}, emb_dims=${embedding.length}`);
    return embedding;
  } catch (err) {
    Logger.warn(`[Dataset] ❌ Feature compute failed for ${filename}: ${err.message}`);
    return null;
  }
}

// ─── Compute features from live AudioBuffer (called from live pipeline) ───────
export function computeFeaturesFromAudioBuffer(audioBuffer) {
  const samples   = audioBuffer.getChannelData(0);
  const processed = preprocessAudioBuffer(samples, audioBuffer.sampleRate);
  return computeCompositeEmbedding(processed, TARGET_SR);
}

// ─── Main: Initialize reference library ──────────────────────────────────────
export async function initializeAudioDataset(forceRefresh = false) {
  if (!forceRefresh && referenceIndex && referenceIndex.length > 0) {
    Logger.info(`[Dataset] Already loaded ${referenceIndex.length} refs — skipping re-init`);
    return;
  }

  referenceIndex = [];
  Logger.info(`🎵 [Dataset] Initializing Vroomie Anomaly Reference Library [${PIPELINE_VERSION}]...`);

  // ── Step 1: Try Supabase DB table (fastest, pre-computed embeddings) ─────────
  try {
    const { data: patterns, error } = await supabase.from('engine_audio_patterns').select('*');
    if (!error && patterns && patterns.length > 0) {
      for (const ref of patterns) {
        let vec = ref.embedding_vector || ref.features || ref.vector;
        if (typeof vec === 'string') {
          try { vec = JSON.parse(vec); } catch { continue; }
        }
        if (!Array.isArray(vec) || vec.length < 100) continue;

        referenceIndex.push({
          id:              ref.id,
          label:           ref.label || ref.name || 'Unknown Anomaly',
          category:        ref.category || 'unknown',
          severity:        ref.severity || 'medium',
          source_file:     ref.source_file || ref.id,
          source:          'supabase_db',
          embedding_vector: vec,
        });
      }
      if (referenceIndex.length > 0) {
        console.log(`[Dataset] ✅ Loaded ${referenceIndex.length} refs from engine_audio_patterns DB.`);
        return;
      }
    }
  } catch (dbErr) {
    Logger.warn('[Dataset] DB table check failed:', dbErr.message);
  }

  // ── Step 2: Try IDB Cache (fast on second load) ────────────────────────────
  let db = null;
  try {
    db = await initDB();
    const cached = await db.getAll(IDB_STORE);
    const valid  = (cached || []).filter(c =>
      Array.isArray(c.embedding_vector) && c.embedding_vector.length >= 140
    );
    if (!forceRefresh && valid.length > 0) {
      referenceIndex = valid;
      console.log(`[Dataset] ✅ Loaded ${referenceIndex.length} refs from IDB cache (v12).`);
      return;
    }
  } catch (idbErr) {
    Logger.warn('[Dataset] IDB read failed:', idbErr.message);
  }

  // ── Step 3: Compute from Storage bucket ────────────────────────────────────
  Logger.info('[Dataset] Computing embeddings from anomaly-patterns bucket...');

  const { data: files, error: listErr } = await supabase.storage
    .from(BUCKET)
    .list('', { limit: 200, sortBy: { column: 'name', order: 'asc' } });

  if (listErr || !files || files.length === 0) {
    Logger.error('[Dataset] Storage list failed or empty:', listErr?.message);
    return;
  }

  const audioFiles = files.filter(f => f.name && /\.(wav|mp3|ogg|webm|flac|m4a)$/i.test(f.name));
  Logger.info(`[Dataset] Found ${audioFiles.length} audio files in bucket.`);

  const computed = [];

  for (const file of audioFiles) {
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(file.name);
    if (!urlData?.publicUrl) continue;

    const meta = inferMetadata(file.name);

    try {
      const embedding = await computeFeaturesFromUrl(urlData.publicUrl, file.name);
      if (!embedding || embedding.length < 140) continue;

      const entry = {
        source_file:      file.name,          // UNIQUE KEY — prevents overwrites
        label:            meta.label,
        category:         meta.category,
        severity:         meta.severity,
        source:           'storage_computed',
        embedding_vector: Array.from(embedding), // serializable for IDB
      };
      computed.push(entry);
      referenceIndex.push(entry);
      Logger.info(`[Dataset] ✅ ${file.name} → "${meta.label}" (${embedding.length}d)`);
    } catch (err) {
      Logger.warn(`[Dataset] ❌ Skipping ${file.name}: ${err.message}`);
    }
  }

  console.log(`[Dataset] ✅ Computed ${referenceIndex.length} refs from storage bucket.`);

  // ── Step 4: Persist to IDB cache ───────────────────────────────────────────
  if (db && computed.length > 0) {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      await tx.store.clear();
      for (const entry of computed) await tx.store.put(entry);
      await tx.done;
      Logger.info(`[Dataset] 💾 Saved ${computed.length} refs to IDB cache (v12).`);
    } catch (idbWriteErr) {
      Logger.warn('[Dataset] IDB write failed:', idbWriteErr.message);
    }
  }
}

/**
 * Force-refresh: clears IDB and recomputes from bucket.
 * Call this from ValidationBench or when bucket files change.
 */
export async function refreshAudioDataset() {
  referenceIndex = [];
  try {
    const db = await initDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    await tx.store.clear();
    await tx.done;
  } catch { /* ignore */ }
  await initializeAudioDataset(true);
}
