/**
 * generate_fingerprints.mjs
 *
 * Generates MFCC-based JSON fingerprints from WAV files in the Supabase
 * 'anomaly-patterns' bucket and uploads them back as .json files.
 *
 * The DSP pipeline here is IDENTICAL to what AudioV5_SuperProcessor.worker.js
 * uses at runtime — ensuring symmetric matching.
 *
 * Usage: node generate_fingerprints.mjs
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const supabaseUrl  = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
// Use service_role key for storage uploads (bypasses RLS).
// If you don't have it, the script will still write fingerprints locally to ./fingerprints/
const supabaseKey  = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const LOCAL_OUT    = './fingerprints';
const sb = createClient(supabaseUrl, supabaseKey);

// ─── MUST MATCH AudioV5_SuperProcessor.worker.js exactly ───────────────────
const TARGET_SR  = 44100;
const FFT_SIZE   = 4096;
const BIN_4KHZ   = Math.round(4000  * FFT_SIZE / TARGET_SR);
const BIN_8KHZ   = Math.round(8000  * FFT_SIZE / TARGET_SR);
const BIN_12KHZ  = Math.round(12000 * FFT_SIZE / TARGET_SR);
const FRAME_SAMPLES = Math.round(TARGET_SR * 0.5); // 500ms

// Fault type mapping from filename to fault type and severity
const FAULT_MAP = {
  'alternator_bearing_fault_critical': { fault_type: 'alternator_bearing_fault', severity: 'critical' },
  'BearingAlternator':                 { fault_type: 'alternator_bearing_fault', severity: 'high' },
  'engine_knocking_high':              { fault_type: 'engine_knock', severity: 'high' },
  'exhaust_resonance_low':             { fault_type: 'exhaust_resonance', severity: 'low' },
  'intake_leak_low':                   { fault_type: 'intake_leak', severity: 'low' },
  'misfire_detected_medium':           { fault_type: 'misfire', severity: 'medium' },
  'MotorStarter':                      { fault_type: 'motor_starter', severity: 'medium' },
  'Piston':                            { fault_type: 'piston_fault', severity: 'high' },
  'PowerSteeringPump':                 { fault_type: 'power_steering', severity: 'medium' },
  'pulley_misalignment_medium':        { fault_type: 'pulley_misalignment', severity: 'medium' },
  'RockerArmAndValve':                 { fault_type: 'rocker_arm', severity: 'high' },
  'SerpentineBelt':                    { fault_type: 'serpentine_belt', severity: 'medium' },
  'timing_chain_rattle_high':          { fault_type: 'timing_chain', severity: 'high' },
  'water_pump_failure_critical':       { fault_type: 'water_pump', severity: 'critical' },
};

// ─── WAV Decoder ─────────────────────────────────────────────────────────────
function decodeWav(buffer) {
  const dv = new DataView(buffer);
  const numChannels  = dv.getUint16(22, true);
  const sampleRate   = dv.getUint32(24, true);
  const bitsPerSample = dv.getUint16(34, true);

  // Find 'data' chunk
  let dataOffset = 44;
  for (let i = 12; i < buffer.byteLength - 8; i++) {
    if (dv.getUint8(i)===0x64 && dv.getUint8(i+1)===0x61 &&
        dv.getUint8(i+2)===0x74 && dv.getUint8(i+3)===0x61) {
      dataOffset = i + 8; break;
    }
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((buffer.byteLength - dataOffset) / bytesPerSample / numChannels);
  const samples    = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const off = dataOffset + i * numChannels * bytesPerSample;
    let val = 0;
    if (bitsPerSample === 16)      val = dv.getInt16(off, true)  / 32768.0;
    else if (bitsPerSample === 32) val = dv.getFloat32(off, true);
    else if (bitsPerSample === 8)  val = (dv.getUint8(off) - 128) / 128.0;
    samples[i] = val;
  }
  return { samples, sampleRate, numChannels };
}

// ─── DSP Utilities (IDENTICAL to worker) ─────────────────────────────────────
function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio  = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out    = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, l = Math.floor(idx), r = Math.min(l+1, signal.length-1);
    out[i] = signal[l] * (1-(idx-l)) + signal[r] * (idx-l);
  }
  return out;
}

function peakNormalize(signal) {
  let maxVal = 0;
  for (let i = 0; i < signal.length; i++) {
    const a = Math.abs(signal[i]);
    if (a > maxVal) maxVal = a;
  }
  if (maxVal < 1e-8) return signal;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] / maxVal;
  return out;
}

function applyHanning(signal, N) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = signal[i] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1))));
  }
  return out;
}

function computeFFT(signal, N) {
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const copyLen = Math.min(signal.length, N);
  for (let i = 0; i < copyLen; i++) re[i] = signal[i];

  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i+k], uIm = im[i+k];
        const vRe = re[i+k+len/2]*curRe - im[i+k+len/2]*curIm;
        const vIm = re[i+k+len/2]*curIm + im[i+k+len/2]*curRe;
        re[i+k] = uRe+vRe; im[i+k] = uIm+vIm;
        re[i+k+len/2] = uRe-vRe; im[i+k+len/2] = uIm-vIm;
        const newRe = curRe*wRe - curIm*wIm;
        curIm = curRe*wIm + curIm*wRe;
        curRe = newRe;
      }
    }
  }
  return { re, im };
}

/**
 * Extract CSD vector from a single PCM frame — IDENTICAL to worker's processFrame().
 * No noise subtraction here (reference files are clean by definition).
 */
function extractFrameVector(frame) {
  const padded = new Float32Array(FFT_SIZE);
  const copyLen = Math.min(frame.length, FFT_SIZE);
  for (let i = 0; i < copyLen; i++) padded[i] = frame[i];

  const windowed = applyHanning(padded, FFT_SIZE);
  const spectrum = computeFFT(windowed, FFT_SIZE);

  const logMag = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    const re = spectrum.re[i], im = spectrum.im[i];
    const mag = Math.sqrt(re*re + im*im);
    logMag[i] = Math.log10(Math.max(Number.EPSILON, mag));
  }

  // Return only the 4kHz–12kHz band (same slice as worker)
  return Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ));
}

/**
 * Convert mono PCM at TARGET_SR to an averaged CSD vector using the same
 * sliding-window approach as AudioV5_SuperProcessor.worker.js.
 */
function computeReferenceVector(pcm) {
  const HOP = Math.round(FRAME_SAMPLES * 0.5);
  const frames = [];

  for (let offset = 0; offset + FRAME_SAMPLES <= pcm.length; offset += HOP) {
    const frame = pcm.slice(offset, offset + FRAME_SAMPLES);
    frames.push(extractFrameVector(frame));
  }

  // Handle tail
  if (pcm.length % FRAME_SAMPLES !== 0) {
    const tail = new Float32Array(FRAME_SAMPLES);
    tail.set(pcm.slice(pcm.length - (pcm.length % FRAME_SAMPLES)));
    frames.push(extractFrameVector(tail));
  }

  if (frames.length === 0) return null;

  const vecLen = frames[0].length;
  const avg = new Array(vecLen).fill(0);
  for (const f of frames) {
    for (let i = 0; i < vecLen; i++) avg[i] += f[i];
  }
  for (let i = 0; i < vecLen; i++) avg[i] /= frames.length;
  return avg;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Listing anomaly-patterns bucket...');
  const { data: files, error: listErr } = await sb.storage.from('anomaly-patterns').list('', { limit: 200 });
  if (listErr) { console.error('List error:', listErr.message); process.exit(1); }

  const wavFiles = files.filter(f => f.name.endsWith('.wav'));
  console.log(`Found ${wavFiles.length} WAV files. Generating fingerprints...\n`);

  for (const file of wavFiles) {
    const baseName = file.name.replace(/\.wav$/, '');
    const jsonName = `${baseName}.json`;

    // Skip if JSON already exists
    const { data: existing } = await sb.storage.from('anomaly-patterns').list('', { search: jsonName });
    if (existing && existing.some(f => f.name === jsonName)) {
      console.log(`⏭  ${jsonName} already exists — skipping.`);
      continue;
    }

    console.log(`🔄 Processing ${file.name}...`);

    const { data: fileData, error: dlErr } = await sb.storage.from('anomaly-patterns').download(file.name);
    if (dlErr || !fileData) { console.error(`  ❌ Download failed: ${dlErr?.message}`); continue; }

    try {
      const arrayBuffer = await fileData.arrayBuffer();
      const { samples, sampleRate, numChannels } = decodeWav(arrayBuffer);

      // Mix to mono if stereo
      let mono;
      if (numChannels === 1) {
        mono = samples;
      } else {
        mono = new Float32Array(Math.floor(samples.length / numChannels));
        for (let i = 0; i < mono.length; i++) {
          let s = 0;
          for (let c = 0; c < numChannels; c++) s += samples[i * numChannels + c];
          mono[i] = s / numChannels;
        }
      }

      // Resample to TARGET_SR and peak-normalize
      const resampled   = linearResample(mono, sampleRate, TARGET_SR);
      const normalized  = peakNormalize(resampled);

      // Compute the reference vector
      const cosineVec = computeReferenceVector(normalized);
      if (!cosineVec) { console.error(`  ❌ Empty audio — skipping.`); continue; }

      const meta = FAULT_MAP[baseName] || { fault_type: baseName, severity: 'medium' };

      const fingerprint = {
        id:          baseName,
        label:       baseName,
        fault_type:  meta.fault_type,
        severity:    meta.severity,
        source_file: file.name,
        cosine_vec:  cosineVec,
        generated_at: new Date().toISOString(),
        pipeline:    'v5-symmetric',
        fft_size:    FFT_SIZE,
        sample_rate: TARGET_SR,
        vec_length:  cosineVec.length,
      };

      // Always write locally first
      if (!fs.existsSync(LOCAL_OUT)) fs.mkdirSync(LOCAL_OUT, { recursive: true });
      const localPath = path.join(LOCAL_OUT, jsonName);
      fs.writeFileSync(localPath, JSON.stringify(fingerprint, null, 2));
      console.log(`  💾 Written locally: ${localPath}`);

      // Attempt Supabase upload
      const jsonBytes = new TextEncoder().encode(JSON.stringify(fingerprint));
      const jsonBlob  = new Blob([jsonBytes], { type: 'application/json' });

      const { error: uploadErr } = await sb.storage
        .from('anomaly-patterns')
        .upload(jsonName, jsonBlob, { contentType: 'application/json', upsert: true });

      if (uploadErr) {
        console.warn(`  ⚠️  Supabase upload failed (${uploadErr.message}). Local file saved — upload manually.`);
      } else {
        console.log(`  ✅ Uploaded ${jsonName} to Supabase bucket.`);
      }
    } catch (err) {
      console.error(`  ❌ Error processing ${file.name}:`, err.message);
    }
  }

  console.log('\n✅ Fingerprint generation complete.');
  console.log(`Local fingerprints written to: ${path.resolve(LOCAL_OUT)}`);
  console.log('Upload them to Supabase via:');
  console.log('  SUPABASE_SERVICE_KEY=<your_service_role_key> node generate_fingerprints.mjs');
  console.log('Or manually upload the .json files in ./fingerprints/ via the Supabase Storage UI.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
