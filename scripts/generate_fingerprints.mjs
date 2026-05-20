/**
 * generate_fingerprints.mjs
 *
 * Generates cosine_vec fingerprints from WAV files stored in the
 * Supabase "anomaly-patterns" bucket and re-uploads them as JSON.
 *
 * PARAMETERS MUST MATCH AudioV6_Calibrator.worker.js EXACTLY:
 *   FFT_SIZE = 4096
 *   TARGET_SR = 44100
 *   BIN_4KHZ  = round(4000 * 4096 / 44100) = 371
 *   BIN_12KHZ = round(12000 * 4096 / 44100) = 1114
 *   Vector length = BIN_12KHZ - BIN_4KHZ = 743
 *
 * Usage:
 *   node scripts/generate_fingerprints.mjs
 *
 * Prerequisites:
 *   npm install @supabase/supabase-js node-wav dotenv
 *   Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env
 */

import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET           = 'anomaly-patterns';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Must match worker exactly ───────────────────────────────────────────────
const TARGET_SR  = 44100;
const FFT_SIZE   = 4096;
const BIN_4KHZ   = Math.round(4000  * FFT_SIZE / TARGET_SR);  // 371
const BIN_12KHZ  = Math.round(12000 * FFT_SIZE / TARGET_SR);  // 1114
const VECTOR_LEN = BIN_12KHZ - BIN_4KHZ;                      // 743
const SS_ALPHA   = 1.5;
const SS_BETA    = 0.01;
const HOP        = FFT_SIZE >> 1;

console.log(`📐 Vector parameters: BIN_4KHZ=${BIN_4KHZ} BIN_12KHZ=${BIN_12KHZ} VECTOR_LEN=${VECTOR_LEN}`);

// ─── FFT (Cooley-Tukey, same as worker) ──────────────────────────────────────
function computeFFT(signal, N) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const copyLen = Math.min(signal.length, N);
  for (let i = 0; i < copyLen; i++) re[i] = signal[i];
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe=re[i+k], uIm=im[i+k];
        const vRe=re[i+k+len/2]*cRe-im[i+k+len/2]*cIm;
        const vIm=re[i+k+len/2]*cIm+im[i+k+len/2]*cRe;
        re[i+k]=uRe+vRe; im[i+k]=uIm+vIm;
        re[i+k+len/2]=uRe-vRe; im[i+k+len/2]=uIm-vIm;
        const nRe=cRe*wRe-cIm*wIm; cIm=cRe*wIm+cIm*wRe; cRe=nRe;
      }
    }
  }
  return { re, im };
}

function applyHanning(signal, N) {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = signal[i] * (0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1))));
  return out;
}

function peakNormalize(signal) {
  let maxVal = 0;
  for (let i = 0; i < signal.length; i++) { const a = Math.abs(signal[i]); if (a > maxVal) maxVal = a; }
  if (maxVal < 1e-9) return signal;
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] / maxVal;
  return out;
}

function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out = new Float64Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, l = Math.floor(idx), r = Math.min(l + 1, signal.length - 1);
    out[i] = signal[l] * (1 - (idx - l)) + signal[r] * (idx - l);
  }
  return out;
}

/**
 * Generate the cosine_vec fingerprint from raw PCM samples.
 * Uses same pipeline as AudioV6_Calibrator.worker.js:
 * - peak normalize
 * - build noise profile from first 100ms
 * - spectral subtraction
 * - average log-magnitude of 4kHz–12kHz band across all frames
 */
function generateCosineVec(pcm, inputSr) {
  // Resample to 44100 if needed
  const samples = inputSr !== TARGET_SR ? linearResample(pcm, inputSr, TARGET_SR) : pcm;
  const normalized = peakNormalize(samples);

  const NOISE_LEN = Math.round(TARGET_SR * 0.1); // 100ms noise profile
  const noiseMag  = new Float64Array(FFT_SIZE / 2);

  // Build noise profile from first 100ms
  let noiseFrameCount = 0;
  let offset = 0;
  while (offset + FFT_SIZE <= NOISE_LEN && offset + FFT_SIZE <= normalized.length) {
    const frame    = normalized.slice(offset, offset + FFT_SIZE);
    const windowed = applyHanning(frame, FFT_SIZE);
    const { re, im } = computeFFT(windowed, FFT_SIZE);
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      noiseMag[i] += Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    }
    noiseFrameCount++;
    offset += HOP;
  }
  if (noiseFrameCount > 0) {
    for (let i = 0; i < FFT_SIZE / 2; i++) noiseMag[i] /= noiseFrameCount;
  }

  // Process all frames and accumulate average log-mag in 4kHz–12kHz band
  const accumVec = new Float64Array(VECTOR_LEN);
  let frameCount = 0;
  offset = 0;

  while (offset + FFT_SIZE <= normalized.length) {
    const frame    = normalized.slice(offset, offset + FFT_SIZE);
    const windowed = applyHanning(frame, FFT_SIZE);
    const { re, im } = computeFFT(windowed, FFT_SIZE);

    for (let i = BIN_4KHZ; i < BIN_12KHZ; i++) {
      const rawMag  = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      const rawPow  = rawMag * rawMag;
      const noisePow = noiseMag[i] * noiseMag[i];
      const cleanPow = Math.max(rawPow - SS_ALPHA * noisePow, SS_BETA * rawPow);
      const cleanMag = Math.sqrt(cleanPow);
      accumVec[i - BIN_4KHZ] += Math.log10(Math.max(Number.EPSILON, cleanMag));
    }
    frameCount++;
    offset += HOP;
  }

  if (frameCount === 0) return null;

  const cosineVec = Array.from(accumVec).map(v => v / frameCount);
  return cosineVec;
}

/**
 * Parse a WAV buffer (PCM 16-bit or 32-bit) into Float32Array.
 * Simple parser — handles standard PCM WAV only.
 */
function parseWav(buffer) {
  const view = new DataView(buffer.buffer || buffer);

  // RIFF header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a WAV file');

  const fmt  = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
  if (fmt !== 'fmt ') throw new Error('Malformed WAV fmt chunk');

  const audioFormat   = view.getUint16(20, true);  // 1=PCM, 3=IEEE float
  const numChannels   = view.getUint16(22, true);
  const sampleRate    = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  if (audioFormat !== 1 && audioFormat !== 3) throw new Error(`Unsupported audio format: ${audioFormat}`);

  // Find 'data' chunk
  let dataOffset = 36;
  while (dataOffset < view.byteLength - 4) {
    const chunkId = String.fromCharCode(
      view.getUint8(dataOffset), view.getUint8(dataOffset+1),
      view.getUint8(dataOffset+2), view.getUint8(dataOffset+3)
    );
    const chunkSize = view.getUint32(dataOffset + 4, true);
    if (chunkId === 'data') {
      dataOffset += 8;
      break;
    }
    dataOffset += 8 + chunkSize;
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((view.byteLength - dataOffset) / (bytesPerSample * numChannels));
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    let monoSample = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const bytePos = dataOffset + (i * numChannels + ch) * bytesPerSample;
      let s = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        s = view.getFloat32(bytePos, true);
      } else if (bitsPerSample === 16) {
        s = view.getInt16(bytePos, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(bytePos), b1 = view.getUint8(bytePos+1), b2 = view.getUint8(bytePos+2);
        let val = (b2 << 16) | (b1 << 8) | b0;
        if (val >= 0x800000) val -= 0x1000000;
        s = val / 8388608;
      } else if (bitsPerSample === 8) {
        s = (view.getUint8(bytePos) - 128) / 128;
      }
      monoSample += s;
    }
    samples[i] = monoSample / numChannels;
  }

  return { samples, sampleRate, numChannels, bitsPerSample };
}

async function main() {
  console.log('🔍 Listing anomaly-patterns bucket...');
  const { data: files, error: listErr } = await supabase.storage
    .from(BUCKET)
    .list('', { limit: 200 });

  if (listErr) {
    console.error('❌ Failed to list bucket:', listErr.message);
    process.exit(1);
  }

  const wavFiles = files.filter(f => f.name.endsWith('.wav') || f.name.endsWith('.WAV'));
  console.log(`Found ${wavFiles.length} WAV files and ${files.filter(f => f.name.endsWith('.json')).length} existing JSON files.`);

  if (wavFiles.length === 0) {
    console.warn('⚠️  No WAV files found in bucket. Cannot generate fingerprints.');
    console.log('\nTo generate fingerprints, upload WAV files named like:');
    console.log('  alternator_bearing_fault_critical.wav');
    console.log('  intake_leak_low.wav');
    console.log('  water_pump_failure_critical.wav');
    console.log('  etc.\n');
    process.exit(0);
  }

  let successCount = 0;
  let failCount = 0;

  for (const file of wavFiles) {
    console.log(`\n📥 Processing: ${file.name}`);

    // Download WAV
    const { data: wavData, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(file.name);

    if (dlErr || !wavData) {
      console.error(`  ❌ Download failed: ${dlErr?.message}`);
      failCount++;
      continue;
    }

    const arrayBuf = await wavData.arrayBuffer();
    const buf      = Buffer.from(arrayBuf);

    let parsed;
    try {
      parsed = parseWav(buf);
    } catch (parseErr) {
      console.error(`  ❌ WAV parse failed: ${parseErr.message}`);
      failCount++;
      continue;
    }

    console.log(`  📊 SR=${parsed.sampleRate} channels=${parsed.numChannels} bits=${parsed.bitsPerSample} samples=${parsed.samples.length}`);

    // Generate fingerprint
    const cosineVec = generateCosineVec(parsed.samples, parsed.sampleRate);
    if (!cosineVec) {
      console.error(`  ❌ Fingerprint generation failed — audio too short`);
      failCount++;
      continue;
    }

    // Derive metadata from filename
    const baseName  = file.name.replace(/\.wav$/i, '');
    const parts     = baseName.split('_');
    let severity    = 'high';
    const SEVERITIES = ['critical', 'high', 'medium', 'low'];
    if (SEVERITIES.includes(parts[parts.length - 1])) {
      severity = parts[parts.length - 1];
    }

    // Determine fault_type (for FAULT_WEIGHTS lookup in worker)
    let faultType = baseName;
    if (baseName.includes('bearing') || baseName.includes('alternator')) faultType = 'alternator_bearing_fault';
    else if (baseName.includes('intake') || baseName.includes('leak'))   faultType = 'intake_leak';
    else if (baseName.includes('water_pump') || baseName.includes('waterpump')) faultType = 'water_pump';
    else if (baseName.includes('starter') || baseName.includes('motor')) faultType = 'motor_starter';
    else if (baseName.includes('piston') || baseName.includes('knock'))  faultType = 'piston_knock';
    else if (baseName.includes('belt') || baseName.includes('serpentine')) faultType = 'belt';
    else if (baseName.includes('power_steering') || baseName.includes('steering')) faultType = 'power_steering';
    else if (baseName.includes('timing') || baseName.includes('chain'))  faultType = 'timing_chain';
    else if (baseName.includes('misfire') || baseName.includes('valve')) faultType = 'misfire';

    // Compute kurtosis and flatness scores for composite matching
    const kurtosisScore  = computeVecKurtosis(cosineVec);
    const flatnessScore  = computeVecFlatness(cosineVec);
    const transientScore = 0.0; // computed per session in worker

    const fingerprint = {
      id:              baseName,
      label:           baseName,
      fault_type:      faultType,
      severity,
      source_file:     file.name,
      sample_rate:     TARGET_SR,
      fft_size:        FFT_SIZE,
      bin_4khz:        BIN_4KHZ,
      bin_12khz:       BIN_12KHZ,
      vector_length:   VECTOR_LEN,
      cosine_vec:      cosineVec,
      kurtosis_score:  kurtosisScore,
      flatness_score:  flatnessScore,
      transient_score: transientScore,
      generated_at:    new Date().toISOString(),
    };

    const jsonName = `${baseName}.json`;
    const jsonBlob = Buffer.from(JSON.stringify(fingerprint));

    // Upload JSON fingerprint
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(jsonName, jsonBlob, {
        contentType: 'application/json',
        upsert: true,
      });

    if (uploadErr) {
      console.error(`  ❌ Upload failed: ${uploadErr.message}`);
      failCount++;
    } else {
      console.log(`  ✅ Fingerprint uploaded: ${jsonName} (${VECTOR_LEN} dims, kurtosis=${kurtosisScore.toFixed(2)}, flatness=${flatnessScore.toFixed(3)})`);
      successCount++;
    }
  }

  console.log(`\n📊 Summary: ${successCount} fingerprints generated, ${failCount} failed`);
  if (successCount > 0) {
    console.log('✅ Fingerprints ready. The Vroomie audio pipeline will load them on next recording session.');
  }
}

function computeVecKurtosis(vec) {
  const N = vec.length;
  if (N === 0) return 3;
  let sum = 0;
  for (const v of vec) sum += v;
  const mean = sum / N;
  let sum2 = 0, sum4 = 0;
  for (const v of vec) { const d = v - mean; sum2 += d*d; sum4 += d*d*d*d; }
  const variance = sum2 / N;
  return variance < 1e-12 ? 3 : (sum4 / N) / (variance * variance);
}

function computeVecFlatness(vec) {
  const N = vec.length;
  if (N === 0) return 0;
  let logSum = 0, arithSum = 0;
  for (const v of vec) {
    const p = Math.max(Number.EPSILON, Math.exp(v * Math.LN10)); // convert log10 back to magnitude
    logSum  += Math.log(p);
    arithSum += p;
  }
  return Math.exp(logSum / N) / Math.max(Number.EPSILON, arithSum / N);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
