import { supabase } from '../lib/supabase';
import { Logger } from '../lib/logger';
import { openDB } from 'idb';

export let referenceIndex = [];

const BUCKET = 'anomaly-patterns';

// ─── IndexedDB Cache ─────────────────────────────────────────────────────────
const initDB = async () => {
  return openDB('vroomie-db', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('anomaly_references')) {
        db.createObjectStore('anomaly_references', { keyPath: 'id' });
      }
    },
  });
};

// ─── Filename → metadata ─────────────────────────────────────────────────────
function inferMetadata(filename) {
  const name = filename.toLowerCase().replace(/\.(wav|mp3|ogg|webm)$/, '');
  if (name.includes('normal') || name.includes('idle') || name.includes('baseline')) {
    return { category: 'normal', severity: 'low', label: `normal_${name}` };
  }
  if (name.includes('knock') || name.includes('ping'))
    return { category: 'engine_knock', severity: 'high', label: `engine_knocking_${name}` };
  if (name.includes('bearing') || name.includes('grind') || name.includes('squeal'))
    return { category: 'bearing_fault', severity: 'critical', label: `bearing_fault_${name}` };
  if (name.includes('misfire') || name.includes('miss'))
    return { category: 'misfire', severity: 'medium', label: `misfire_${name}` };
  if (name.includes('belt') || name.includes('pulley') || name.includes('squeak'))
    return { category: 'belt_issue', severity: 'medium', label: `belt_squeal_${name}` };
  if (name.includes('exhaust') || name.includes('rattle'))
    return { category: 'exhaust_issue', severity: 'medium', label: `exhaust_leak_${name}` };
  return { category: 'unknown_anomaly', severity: 'medium', label: `anomaly_${name}` };
}

// ─── In-browser MFCC from AudioBuffer ────────────────────────────────────────
async function computeMFCCFromUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    
    const audioCtx = new OfflineAudioContext(1, 44100 * 5, 44100);
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    
    const samples = decoded.getChannelData(0);
    const sampleRate = decoded.sampleRate;
    return computeMFCC(samples, sampleRate);
  } catch (err) {
    Logger.warn(`MFCC decode failed for ${url}: ${err.message}`);
    return null;
  }
}

// ─── MFCC computation (browser-compatible) ───────────────────────────────────
function computeMFCC(samples, sampleRate) {
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
  
  const norm = Math.sqrt(mfcc.reduce((a, v) => a + v * v, 0)) || 1;
  return Array.from(mfcc).map(v => parseFloat((v / norm).toFixed(6)));
}

// ─── Compute MFCC from live AudioBuffer ──────────────────────────────────────
export function computeMFCCFromAudioBuffer(audioBuffer) {
  const samples = audioBuffer.getChannelData(0);
  return computeMFCC(samples, audioBuffer.sampleRate);
}

// ─── Main: Initialize reference library ──────────────────────────────────────
export async function initializeAudioDataset() {
  referenceIndex = [];
  Logger.info('🎵 Initializing Anomaly Reference Library...');
  
  const db = await initDB().catch(() => null);

  // ── STEP 1: Try loading pre-computed embeddings from anomaly_references table ──
  try {
    const { data: dbRefs, error } = await supabase
      .from('anomaly_references')
      .select('*');
    
    if (!error && dbRefs && dbRefs.length > 0) {
      Logger.info(`✅ Loaded ${dbRefs.length} pre-computed references from DB.`);
      
      for (const ref of dbRefs) {
        let vec = ref.embedding_vector;
        if (typeof vec === 'string') {
          try { vec = JSON.parse(vec); } catch { continue; }
        }
        if (!Array.isArray(vec) || vec.length === 0) continue;
        
        referenceIndex.push({
          id: ref.id,
          label: ref.label,
          category: ref.category,
          severity: ref.severity || 'medium',
          source: 'supabase_db',
          embedding_vector: vec,
          public_url: ref.public_url,
          audioBufferPath: ref.source_file,
        });
      }
      
      // Cache to IndexedDB
      if (db) {
        const tx = db.transaction('anomaly_references', 'readwrite');
        await tx.store.clear();
        for (const ref of dbRefs) await tx.store.put({ ...ref, id: ref.id || ref.label });
        await tx.done;
      }
      
      Logger.info(`🔍 Reference engine ready: ${referenceIndex.length} patterns loaded.`);
      return;
    }
  } catch (err) {
    Logger.warn('Supabase DB fetch failed, checking IDB cache:', err.message);
  }

  // ── STEP 2: Try IndexedDB offline cache ──────────────────────────────────────
  if (db) {
    try {
      const cached = await db.getAll('anomaly_references');
      if (cached && cached.length > 0) {
        Logger.info(`📦 Loaded ${cached.length} refs from IndexedDB cache (offline).`);
        for (const ref of cached) {
          let vec = ref.embedding_vector;
          if (typeof vec === 'string') { try { vec = JSON.parse(vec); } catch { continue; } }
          if (!Array.isArray(vec) || vec.length === 0) continue;
          referenceIndex.push({
            label: ref.label, category: ref.category, severity: ref.severity || 'medium',
            source: 'idb_cache', embedding_vector: vec, public_url: ref.public_url,
          });
        }
        if (referenceIndex.length > 0) return;
      }
    } catch (cacheErr) {
      Logger.warn('IDB cache read failed:', cacheErr.message);
    }
  }

  // ── STEP 3: Auto-generate MFCC embeddings from Storage bucket files ──────────
  Logger.info(`📂 Fetching .wav files from '${BUCKET}' bucket to build embeddings on-the-fly...`);
  
  try {
    const { data: files, error: listErr } = await supabase.storage
      .from(BUCKET)
      .list('', { limit: 200, sortBy: { column: 'name', order: 'asc' } });
    
    if (listErr) {
      Logger.error('Storage list failed (check public bucket policy):', listErr.message);
      return;
    }
    
    const audioFiles = (files || []).filter(f => f.name && /\.(wav|mp3|ogg|webm)$/i.test(f.name));
    
    if (audioFiles.length === 0) {
      Logger.warn('⚠️ No audio files found in anomaly-patterns bucket. Upload .wav files to enable matching.');
      return;
    }
    
    Logger.info(`Found ${audioFiles.length} audio files. Computing MFCC embeddings...`);
    
    const toInsert = [];
    
    for (const file of audioFiles) {
      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(file.name);
      const publicUrl = urlData.publicUrl;
      const meta = inferMetadata(file.name);
      
      try {
        const embedding = await computeMFCCFromUrl(publicUrl);
        if (!embedding) continue;
        
        const refEntry = {
          label: meta.label,
          category: meta.category,
          severity: meta.severity,
          source_file: file.name,
          storage_path: file.name,
          public_url: publicUrl,
          embedding_vector: embedding,
          notes: 'Auto-computed on client load',
        };
        
        toInsert.push(refEntry);
        
        referenceIndex.push({
          label: meta.label, category: meta.category, severity: meta.severity,
          source: 'storage_computed', embedding_vector: embedding, public_url: publicUrl,
        });
        
        Logger.info(`  ✅ ${file.name} → [${meta.category}] embedding computed.`);
      } catch (err) {
        Logger.warn(`  ❌ Skipping ${file.name}: ${err.message}`);
      }
    }
    
    // Persist computed embeddings to DB for future loads
    if (toInsert.length > 0) {
      const { error: upsertErr } = await supabase
        .from('anomaly_references')
        .upsert(toInsert, { onConflict: 'label' });
      
      if (upsertErr) {
        Logger.warn('Could not persist embeddings to DB:', upsertErr.message);
      } else {
        Logger.info(`✅ Persisted ${toInsert.length} embeddings to anomaly_references for future use.`);
      }
    }
    
    Logger.info(`🔍 Reference engine ready: ${referenceIndex.length} patterns from Storage.`);
    
  } catch (err) {
    Logger.error('Storage-based initialization failed:', err);
  }
}
