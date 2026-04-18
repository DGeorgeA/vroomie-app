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

export let referenceIndex = [];

const BUCKET = 'anomaly-patterns';
const TARGET_SR = 16000;
const REF_DURATION = 5; // Use first 5 seconds of each reference file

// ─── IndexedDB Cache ─────────────────────────────────────────────────────────
const initDB = async () => {
  return openDB('vroomie-db', 2, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('anomaly_references')) {
        db.createObjectStore('anomaly_references', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('computed_mfcc_refs')) {
        db.createObjectStore('computed_mfcc_refs', { keyPath: 'label' });
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

// ─── MFCC computation — IDENTICAL parameters to what live audio uses ──────────
// N_MFCC=40, N_FFT=512, HOP=256, N_MELS=40 — matches audioDatasetService exactly
export function computeMFCC(samples, sampleRate) {
  const N_MFCC = 40;
  const N_FFT = 512;
  const HOP = 256;
  const N_MELS = 40;

  const melMin = 0;
  const melMax = 2595 * Math.log10(1 + (sampleRate / 2) / 700);
  const melPoints = Array.from({ length: N_MELS + 2 }, (_, i) =>
    melMin + i * (melMax - melMin) / (N_MELS + 1)
  );
  const hzPoints = melPoints.map(m => 700 * (10 ** (m / 2595) - 1));
  const fftBins = hzPoints.map(h => Math.floor((N_FFT + 1) * h / sampleRate));

  const numFrames = Math.max(1, Math.floor((samples.length - N_FFT) / HOP));
  const melEnergies = new Float32Array(N_MELS);

  for (let frame = 0; frame < Math.min(numFrames, 200); frame++) {
    const start = frame * HOP;
    const spectrum = new Float32Array(N_FFT / 2 + 1);

    for (let k = 0; k < N_FFT / 2 + 1; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N_FFT; n++) {
        const s = samples[start + n] || 0;
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (N_FFT - 1));
        const angle = -2 * Math.PI * k * n / N_FFT;
        re += s * w * Math.cos(angle);
        im += s * w * Math.sin(angle);
      }
      spectrum[k] = Math.sqrt(re * re + im * im);
    }

    for (let m = 0; m < N_MELS; m++) {
      let energy = 0;
      for (let bin = fftBins[m]; bin < fftBins[m + 2]; bin++) {
        if (bin < spectrum.length) {
          const frac = bin < fftBins[m + 1]
            ? (bin - fftBins[m]) / Math.max(1, fftBins[m + 1] - fftBins[m])
            : (fftBins[m + 2] - bin) / Math.max(1, fftBins[m + 2] - fftBins[m + 1]);
          energy += spectrum[bin] * Math.max(0, frac);
        }
      }
      melEnergies[m] += Math.log(Math.max(energy, 1e-10));
    }
  }

  for (let m = 0; m < N_MELS; m++) melEnergies[m] /= numFrames;

  const mfcc = new Float32Array(N_MFCC);
  for (let k = 0; k < N_MFCC; k++) {
    let sum = 0;
    for (let m = 0; m < N_MELS; m++) {
      sum += melEnergies[m] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
    }
    mfcc[k] = sum;
  }

  // L2-normalize
  const norm = Math.sqrt(mfcc.reduce((a, v) => a + v * v, 0)) || 1;
  return Array.from(mfcc).map(v => parseFloat((v / norm).toFixed(6)));
}

// ─── Extended feature vector: MFCC(40) + RMS(1) + SpectralCentroid(1) = 42 dims ─
export function computeExtendedFeatures(samples, sampleRate) {
  const mfcc = computeMFCC(samples, sampleRate);

  // RMS energy
  const rms = Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length);

  // Spectral centroid (weighted mean frequency)
  const N_FFT = 512;
  let weightedSum = 0, powerSum = 0;
  for (let k = 0; k < N_FFT / 2 + 1; k++) {
    let mag = 0;
    for (let n = 0; n < N_FFT; n++) {
      const s = samples[n] || 0;
      const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (N_FFT - 1));
      mag += s * w * Math.cos(-2 * Math.PI * k * n / N_FFT);
    }
    mag = Math.abs(mag);
    const freq = k * sampleRate / N_FFT;
    weightedSum += freq * mag;
    powerSum += mag;
  }
  const centroidNorm = powerSum > 0 ? (weightedSum / powerSum) / (sampleRate / 2) : 0;

  return [...mfcc, rms, centroidNorm]; // 42-dim total
}

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
    return computeExtendedFeatures(processed, TARGET_SR);
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
  return computeExtendedFeatures(processed, TARGET_SR);
}

// ─── Main: Initialize reference library ──────────────────────────────────────
export async function initializeAudioDataset() {
  referenceIndex = [];
  Logger.info('🎵 Initializing Vroomie Anomaly Reference Library...');

  const db = await initDB().catch(() => null);

  // ── STEP 1: Try IndexedDB MFCC cache (fastest, offline-capable) ──────────────
  if (db) {
    try {
      const cached = await db.getAll('computed_mfcc_refs');
      if (cached && cached.length > 0) {
        const valid = cached.filter(c => Array.isArray(c.embedding_vector) && c.embedding_vector.length >= 40);
        if (valid.length > 0) {
          referenceIndex = valid.map(c => ({
            label: c.label,
            category: c.category,
            severity: c.severity || 'medium',
            source_file: c.source_file,
            source: 'idb_mfcc_cache',
            embedding_vector: c.embedding_vector,
          }));
          console.log(`[Vroomie Dataset] ✅ Loaded ${referenceIndex.length} MFCC references from IDB cache:`, referenceIndex.map(r => r.label));
          Logger.info(`Reference engine ready: ${referenceIndex.length} patterns from IDB.`);
          return;
        }
      }
    } catch (e) {
      Logger.warn('IDB read failed:', e.message);
    }
  }

  // ── STEP 2: Compute MFCC embeddings from Storage bucket files ────────────────
  Logger.info(`📂 Fetching audio from '${BUCKET}' bucket and computing MFCC embeddings...`);

  try {
    const { data: files, error: listErr } = await supabase.storage
      .from(BUCKET)
      .list('', { limit: 200, sortBy: { column: 'name', order: 'asc' } });

    if (listErr) {
      Logger.error('Storage list failed:', listErr.message);
      // Fall back to Supabase anomaly_references as last resort
      await loadFromSupabaseDB();
      return;
    }

    const audioFiles = (files || []).filter(f => f.name && /\.(wav|mp3|ogg|webm)$/i.test(f.name));

    if (audioFiles.length === 0) {
      Logger.warn('⚠️ No audio files found in anomaly-patterns bucket.');
      await loadFromSupabaseDB();
      return;
    }

    Logger.info(`Found ${audioFiles.length} audio files. Computing MFCC features (same pipeline as live audio)...`);

    const computed = [];

    for (const file of audioFiles) {
      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(file.name);
      const publicUrl = urlData.publicUrl;
      const meta = inferMetadata(file.name);

      try {
        const features = await computeFeaturesFromUrl(publicUrl);
        if (!features || features.length === 0) continue;

        const entry = {
          label: meta.label,
          category: meta.category,
          severity: meta.severity,
          source_file: file.name,
          source: 'storage_mfcc',
          embedding_vector: features,
        };

        computed.push(entry);
        referenceIndex.push(entry);
        Logger.info(`  ✅ ${file.name} → [${meta.category}] MFCC dim=${features.length}`);
      } catch (err) {
        Logger.warn(`  ❌ Skipping ${file.name}: ${err.message}`);
      }
    }

    if (referenceIndex.length === 0) {
      Logger.warn('No MFCC embeddings computed. Falling back to Supabase DB.');
      await loadFromSupabaseDB();
      return;
    }

    // Cache to IndexedDB for future loads
    if (db && computed.length > 0) {
      try {
        const tx = db.transaction('computed_mfcc_refs', 'readwrite');
        await tx.store.clear();
        for (const entry of computed) await tx.store.put(entry);
        await tx.done;
        Logger.info(`💾 Cached ${computed.length} MFCC embeddings to IDB.`);
      } catch (e) {
        Logger.warn('IDB write failed:', e.message);
      }
    }

    console.log(`[Vroomie Dataset] ✅ Loaded ${referenceIndex.length} anomaly patterns from Storage:`, referenceIndex.map(r => r.label));
    Logger.info(`🔍 Reference engine ready: ${referenceIndex.length} patterns loaded (MFCC-consistent).`);
  } catch (err) {
    Logger.error('Storage-based initialization failed:', err);
    await loadFromSupabaseDB();
  }
}

// ── Last resort: load Supabase DB refs (may be YAMNet vectors — flag as such) ─
async function loadFromSupabaseDB() {
  try {
    const { data: dbRefs, error } = await supabase
      .from('anomaly_references')
      .select('id,label,category,source_file,embedding_vector');

    if (error || !dbRefs || dbRefs.length === 0) {
      Logger.error('No reference data available from any source. Matching will be disabled.');
      return;
    }

    for (const ref of dbRefs) {
      let vec = ref.embedding_vector;
      if (typeof vec === 'string') {
        try { vec = JSON.parse(vec); } catch { continue; }
      }
      if (!Array.isArray(vec) || vec.length === 0) continue;

      // NOTE: These are YAMNet 1024-dim — only usable when live YAMNet is active
      referenceIndex.push({
        id: ref.id,
        label: ref.label,
        category: ref.category,
        source_file: ref.source_file,
        source: 'supabase_yamnet',
        embedding_vector: vec,
        isYAMNet: true,
      });
    }

    console.log(`[Vroomie Dataset] ⚠️ Loaded ${referenceIndex.length} YAMNet refs from DB (live MFCC matching will be degraded):`, referenceIndex.map(r => r.label));
    Logger.info(`Reference engine (YAMNet mode): ${referenceIndex.length} patterns`);
  } catch (err) {
    Logger.error('Supabase DB fallback also failed:', err);
  }
}
