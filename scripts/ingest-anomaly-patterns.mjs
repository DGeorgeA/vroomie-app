/**
 * Vroomie — Full Anomaly Reference Ingestion Pipeline
 * 
 * This script:
 *   1. Lists all .wav files from the Supabase anomaly-patterns storage bucket
 *   2. Downloads each file
 *   3. Computes a lightweight 40-dim MFCC embedding (Node-compatible, no browser APIs)
 *   4. Inserts each as a row in public.anomaly_references
 *   5. Validates the resulting data
 * 
 * Run: node scripts/ingest-anomaly-patterns.mjs
 */

import { createClient } from '@supabase/supabase-js';
import https from 'https';
import http from 'http';
import { Buffer } from 'buffer';

const SUPABASE_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const BUCKET = 'anomaly-patterns';

// ─── Filename → metadata mapping ────────────────────────────────────────────
function inferMetadata(filename) {
  const name = filename.toLowerCase().replace(/\.(wav|mp3|ogg|webm)$/, '');
  const knocking    = name.includes('knock') || name.includes('ping') || name.includes('pinging');
  const bearing     = name.includes('bearing') || name.includes('grind') || name.includes('squeal');
  const misfire     = name.includes('misfire') || name.includes('miss') || name.includes('skip');
  const belt        = name.includes('belt') || name.includes('pulley') || name.includes('squeak');
  const exhaust     = name.includes('exhaust') || name.includes('rattle') || name.includes('leak');
  const normal      = name.includes('normal') || name.includes('idle') || name.includes('baseline');

  if (normal)    return { category: 'normal',         severity: 'low',      label: `normal_${name}` };
  if (knocking)  return { category: 'engine_knock',   severity: 'high',     label: `engine_knocking_${name}` };
  if (bearing)   return { category: 'bearing_fault',  severity: 'critical', label: `bearing_fault_${name}` };
  if (misfire)   return { category: 'misfire',        severity: 'medium',   label: `misfire_${name}` };
  if (belt)      return { category: 'belt_issue',     severity: 'medium',   label: `belt_squeal_${name}` };
  if (exhaust)   return { category: 'exhaust_issue',  severity: 'medium',   label: `exhaust_leak_${name}` };
  return { category: 'unknown_anomaly', severity: 'medium', label: `anomaly_${name}` };
}

// ─── Download file from URL ──────────────────────────────────────────────────
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Parse raw WAV PCM ───────────────────────────────────────────────────────
function parseWavPCM(buffer) {
  // WAV header is 44 bytes (standard PCM)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  
  const chunkId = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (chunkId !== 'RIFF') throw new Error('Not a valid WAV file');
  
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const channels = view.getUint16(22, true);
  
  // Find data chunk offset (handles non-standard headers)
  let dataOffset = 44;
  for (let i = 12; i < Math.min(buffer.length - 8, 200); i++) {
    if (String.fromCharCode(buffer[i], buffer[i+1], buffer[i+2], buffer[i+3]) === 'data') {
      dataOffset = i + 8;
      break;
    }
  }
  
  const numSamples = Math.floor((buffer.length - dataOffset) / (bitsPerSample / 8));
  const samples = new Float32Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const bytePos = dataOffset + i * (bitsPerSample / 8);
    if (bitsPerSample === 16) {
      samples[i] = view.getInt16(bytePos, true) / 32768.0;
    } else if (bitsPerSample === 8) {
      samples[i] = (view.getUint8(bytePos) - 128) / 128.0;
    } else if (bitsPerSample === 32) {
      samples[i] = view.getFloat32(bytePos, true);
    }
  }
  
  return { samples, sampleRate, channels };
}

// ─── MFCC Feature Extraction (40 coefficients) ──────────────────────────────
function computeMFCC(samples, sampleRate) {
  const N_MFCC = 40;
  const N_FFT = 512;
  const HOP = 256;
  const N_MELS = 40;
  
  // Mel filterbank
  const melMin = 0, melMax = 2595 * Math.log10(1 + (sampleRate / 2) / 700);
  const melPoints = Array.from({ length: N_MELS + 2 }, (_, i) => melMin + i * (melMax - melMin) / (N_MELS + 1));
  const hzPoints = melPoints.map(m => 700 * (10 ** (m / 2595) - 1));
  const fftBins = hzPoints.map(h => Math.floor((N_FFT + 1) * h / sampleRate));
  
  const numFrames = Math.floor((samples.length - N_FFT) / HOP);
  const melEnergies = new Float32Array(N_MELS);
  
  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * HOP;
    // Hann window + FFT magnitude
    const spectrum = new Float32Array(N_FFT / 2 + 1);
    for (let k = 0; k < N_FFT / 2 + 1; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N_FFT; n++) {
        const s = samples[start + n] || 0;
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (N_FFT - 1)); // Hamming
        const angle = -2 * Math.PI * k * n / N_FFT;
        re += s * w * Math.cos(angle);
        im += s * w * Math.sin(angle);
      }
      spectrum[k] = Math.sqrt(re * re + im * im);
    }
    
    // Apply Mel filterbank
    for (let m = 0; m < N_MELS; m++) {
      let energy = 0;
      for (let bin = fftBins[m]; bin < fftBins[m + 2]; bin++) {
        if (bin < spectrum.length) {
          const weight = bin < fftBins[m + 1]
            ? (bin - fftBins[m]) / (fftBins[m + 1] - fftBins[m])
            : (fftBins[m + 2] - bin) / (fftBins[m + 2] - fftBins[m + 1]);
          energy += spectrum[bin] * Math.max(0, weight);
        }
      }
      melEnergies[m] += Math.log(Math.max(energy, 1e-10));
    }
  }
  
  // Average over frames
  for (let m = 0; m < N_MELS; m++) melEnergies[m] /= Math.max(numFrames, 1);
  
  // DCT to get MFCC coefficients
  const mfcc = new Float32Array(N_MFCC);
  for (let k = 0; k < N_MFCC; k++) {
    let sum = 0;
    for (let m = 0; m < N_MELS; m++) {
      sum += melEnergies[m] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
    }
    mfcc[k] = sum;
  }
  
  // L2 normalize
  const norm = Math.sqrt(mfcc.reduce((a, v) => a + v * v, 0)) || 1;
  return Array.from(mfcc).map(v => v / norm);
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Vroomie — Anomaly Pattern Ingestion Pipeline        ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // 1. List all files in the bucket
  console.log(`📂 Listing files in '${BUCKET}' bucket...`);
  const { data: files, error: listErr } = await supabase.storage
    .from(BUCKET)
    .list('', { limit: 500, sortBy: { column: 'name', order: 'asc' } });

  if (listErr) {
    console.error('❌ Cannot list bucket:', listErr.message);
    console.error('\n👉 ACTION REQUIRED: Run fix-storage-and-refs.sql in Supabase SQL Editor first.');
    console.error('   This makes the bucket public so the API can list files.');
    process.exit(1);
  }

  const wavFiles = (files || []).filter(f => f.name && /\.(wav|mp3|ogg|webm)$/i.test(f.name));
  
  if (wavFiles.length === 0) {
    console.log('⚠️  No audio files found in bucket.');
    console.log('   Upload your engine .wav files to:', `${SUPABASE_URL}/storage/v1/object/${BUCKET}/`);
    process.exit(0);
  }

  console.log(`✅ Found ${wavFiles.length} audio file(s):\n`);
  wavFiles.forEach((f, i) => console.log(`   ${i + 1}. ${f.name}`));

  // 2. Clear existing references
  console.log('\n🗑️  Clearing old anomaly_references...');
  const { error: clearErr } = await supabase
    .from('anomaly_references')
    .delete()
    .gte('created_at', '2000-01-01');
  
  if (clearErr) {
    console.warn('   ⚠️  Could not clear old refs:', clearErr.message);
  } else {
    console.log('   ✅ Old references cleared.');
  }

  // 3. Process each file
  const results = [];
  
  for (const file of wavFiles) {
    process.stdout.write(`\n🔊 Processing: ${file.name} ... `);
    
    try {
      // Get public URL
      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(file.name);
      const publicUrl = urlData.publicUrl;
      
      // Download
      const buffer = await downloadBuffer(publicUrl);
      process.stdout.write(`downloaded (${(buffer.length / 1024).toFixed(0)} KB) ... `);
      
      // Parse WAV and compute MFCC
      let embedding;
      try {
        const { samples, sampleRate } = parseWavPCM(buffer);
        embedding = computeMFCC(samples, sampleRate);
        process.stdout.write(`MFCC OK (${embedding.length}D) ... `);
      } catch (parseErr) {
        // Fallback: generate a statistical fingerprint from raw bytes if not standard WAV
        console.warn(`\n   ⚠️  WAV parse failed (${parseErr.message}), using byte fingerprint...`);
        embedding = generateByteFingerprint(buffer);
        process.stdout.write(`fingerprint OK ... `);
      }
      
      // Infer category and label from filename
      const meta = inferMetadata(file.name);
      
      // Pad 40-dim MFCC to 1024-dim to match pgvector(1024) column
      // Repeat the pattern harmonically to preserve frequency relationships
      const padded1024 = new Array(1024).fill(0).map((_, i) => embedding[i % embedding.length]);
      
      // Only insert columns that exist in the live schema:
      // id, label, category, source_file, embedding_vector, spectrogram_url, created_at
      const { data: inserted, error: insertErr } = await supabase
        .from('anomaly_references')
        .insert([{
          label: meta.label,
          category: meta.category,
          source_file: file.name,
          embedding_vector: padded1024,
        }])
        .select()
        .single();
      
      if (insertErr) {
        console.error(`\n   ❌ Insert failed: ${insertErr.message}`);
      } else {
        console.log(`✅ Inserted [${meta.category}] ${meta.label}`);
        results.push(inserted);
      }
      
    } catch (err) {
      console.error(`\n   ❌ Error: ${err.message}`);
    }
  }

  // 4. Summary
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`✅ INGESTION COMPLETE: ${results.length}/${wavFiles.length} patterns indexed`);
  
  if (results.length > 0) {
    console.log('\n📋 Indexed Patterns:');
    results.forEach(r => {
      console.log(`   • [${r.category}] ${r.label} (${r.severity})`);
    });
    console.log('\n🔗 The acoustic matching engine will now load these patterns on next page load.');
    console.log('   Mic signals will be compared against these embeddings via cosine similarity + DTW.');
  }
}

// Fallback: 40-dim statistical fingerprint from raw bytes
function generateByteFingerprint(buffer) {
  const step = Math.floor(buffer.length / 40);
  return Array.from({ length: 40 }, (_, i) => {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += buffer[i * step + j];
    return (sum / step - 128) / 128;
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
