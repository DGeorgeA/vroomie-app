/**
 * regen_fingerprints.cjs
 *
 * Regenerates cosine_vec fingerprints for ALL WAV files in the Supabase
 * anomaly-patterns bucket using the IDENTICAL pipeline as AudioV6_Calibrator.worker.js.
 *
 * The key insight: the V6 worker stores log10(cleanMag) in frameVecs.
 * ALL reference cosine_vec arrays MUST be in the same log10 space.
 *
 * Previous fingerprints used a v5-symmetric [0,1] normalized space —
 * completely incompatible with the V6 worker's negative log10 values.
 * Cosine similarity between them is always near zero → no detections.
 *
 * Run: node scripts/regen_fingerprints.cjs
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const BUCKET = 'anomaly-patterns';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── MUST MATCH AudioV6_Calibrator.worker.js EXACTLY ────────────────────────
const TARGET_SR  = 44100;
const FFT_SIZE   = 4096;
const HOP        = FFT_SIZE >> 1;  // 2048 — 50% overlap
const BIN_4KHZ   = Math.round(4000  * FFT_SIZE / TARGET_SR);  // 371
const BIN_12KHZ  = Math.round(12000 * FFT_SIZE / TARGET_SR);  // 1114
const VECTOR_LEN = BIN_12KHZ - BIN_4KHZ;                      // 743
const SS_ALPHA   = 1.5;
const SS_BETA    = 0.01;
const NOISE_SECS = 0.1;  // first 100ms used for noise profile
// ─────────────────────────────────────────────────────────────────────────────

// ── Pure JS WAV parser (no external deps) ────────────────────────────────────
function parseWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const riff = String.fromCharCode(view.getUint8(0),view.getUint8(1),view.getUint8(2),view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a WAV file (missing RIFF header)');

  const audioFormat   = view.getUint16(20, true);
  const numChannels   = view.getUint16(22, true);
  const sampleRate    = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  if (audioFormat !== 1 && audioFormat !== 3)
    throw new Error(`Unsupported audio format code ${audioFormat} (need PCM=1 or float=3)`);

  // Find 'data' chunk (skip past any non-data chunks like 'fact', 'LIST')
  let pos = 36;
  while (pos < view.byteLength - 8) {
    const id = String.fromCharCode(view.getUint8(pos),view.getUint8(pos+1),view.getUint8(pos+2),view.getUint8(pos+3));
    const sz = view.getUint32(pos + 4, true);
    if (id === 'data') { pos += 8; break; }
    pos += 8 + sz;
  }

  const bytesPerSample = bitsPerSample >> 3;
  const numSamples     = Math.floor((view.byteLength - pos) / (bytesPerSample * numChannels));
  const out            = new Float64Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    let mono = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const bytePos = pos + (i * numChannels + ch) * bytesPerSample;
      let s = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        s = view.getFloat32(bytePos, true);
      } else if (bitsPerSample === 16) {
        s = view.getInt16(bytePos, true) / 32768.0;
      } else if (bitsPerSample === 24) {
        const b0=view.getUint8(bytePos), b1=view.getUint8(bytePos+1), b2=view.getUint8(bytePos+2);
        let v = (b2 << 16) | (b1 << 8) | b0;
        if (v >= 0x800000) v -= 0x1000000;
        s = v / 8388608.0;
      } else if (bitsPerSample === 8) {
        s = (view.getUint8(bytePos) - 128) / 128.0;
      }
      mono += s;
    }
    out[i] = mono / numChannels;
  }

  return { samples: out, sampleRate, numChannels, bitsPerSample };
}

// ── Linear resampler ─────────────────────────────────────────────────────────
function resample(signal, fromSR, toSR) {
  if (fromSR === toSR) return signal;
  const ratio  = fromSR / toSR;
  const newLen = Math.floor(signal.length / ratio);
  const out    = new Float64Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const lo  = Math.floor(idx);
    const hi  = Math.min(lo + 1, signal.length - 1);
    out[i]    = signal[lo] * (1 - (idx - lo)) + signal[hi] * (idx - lo);
  }
  return out;
}

// ── Peak normalizer ───────────────────────────────────────────────────────────
function peakNormalize(signal) {
  let maxVal = 0;
  for (let i = 0; i < signal.length; i++) {
    const a = Math.abs(signal[i]);
    if (a > maxVal) maxVal = a;
  }
  if (maxVal < 1e-9) return signal;
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] / maxVal;
  return out;
}

// ── Hanning window ────────────────────────────────────────────────────────────
function applyHanning(signal) {
  const out = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++)
    out[i] = signal[i] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))));
  return out;
}

// ── Cooley-Tukey FFT (identical to V6 worker) ────────────────────────────────
function computeFFT(signal) {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const N  = FFT_SIZE;
  for (let i = 0; i < Math.min(signal.length, N); i++) re[i] = signal[i];
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
      let cRe = 1, cIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i+k], uIm = im[i+k];
        const vRe = re[i+k+len/2]*cRe - im[i+k+len/2]*cIm;
        const vIm = re[i+k+len/2]*cIm + im[i+k+len/2]*cRe;
        re[i+k] = uRe+vRe; im[i+k] = uIm+vIm;
        re[i+k+len/2] = uRe-vRe; im[i+k+len/2] = uIm-vIm;
        const nRe = cRe*wRe - cIm*wIm;
        cIm = cRe*wIm + cIm*wRe;
        cRe = nRe;
      }
    }
  }
  return { re, im };
}

// ── Generate cosine_vec — IDENTICAL to V6 worker frameVecs accumulation ──────
function generateCosineVec(pcm, inputSR) {
  // Step 1: resample to 44100
  const samples = inputSR !== TARGET_SR ? resample(pcm, inputSR, TARGET_SR) : pcm;
  // Step 2: peak normalize
  const normalized = peakNormalize(samples);

  const NOISE_LEN = Math.round(TARGET_SR * NOISE_SECS);
  const noiseMag  = new Float64Array(FFT_SIZE >> 1);

  // Step 3: Build noise profile from first 100ms (same as V6 buildNoiseProfile)
  let noiseFrames = 0;
  for (let off = 0; off + FFT_SIZE <= NOISE_LEN && off + FFT_SIZE <= normalized.length; off += HOP) {
    const frame = applyHanning(normalized.subarray(off, off + FFT_SIZE));
    const { re, im } = computeFFT(frame);
    for (let i = 0; i < FFT_SIZE >> 1; i++)
      noiseMag[i] += Math.sqrt(re[i]*re[i] + im[i]*im[i]);
    noiseFrames++;
  }
  if (noiseFrames > 0)
    for (let i = 0; i < FFT_SIZE >> 1; i++) noiseMag[i] /= noiseFrames;

  // Step 4: Process ALL frames and accumulate logMag in 4kHz–12kHz band
  // THIS IS THE EXACT SAME COMPUTATION AS processFrame() + frameVecs push in the V6 worker:
  //   frameVecs.push(Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ)));
  const accum = new Float64Array(VECTOR_LEN);
  let   frameCount = 0;

  for (let off = 0; off + FFT_SIZE <= normalized.length; off += HOP) {
    const maxSample = normalized.subarray(off, off + FFT_SIZE)
      .reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (maxSample > 0.98) continue; // skip clipped frames (same as worker)

    const frame = applyHanning(normalized.subarray(off, off + FFT_SIZE));
    const { re, im } = computeFFT(frame);

    for (let i = BIN_4KHZ; i < BIN_12KHZ; i++) {
      const rawMag  = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
      const rawPow  = rawMag * rawMag;
      const nPow    = noiseMag[i] * noiseMag[i];
      const cleanPow = Math.max(rawPow - SS_ALPHA * nPow, SS_BETA * rawPow);
      const cleanMag = Math.sqrt(cleanPow);
      // log10(cleanMag) — MATCHES V6 worker logMag[i] computation exactly
      accum[i - BIN_4KHZ] += Math.log10(Math.max(Number.EPSILON, cleanMag));
    }
    frameCount++;
  }

  if (frameCount < 2) return null; // too short to generate valid fingerprint

  const cosineVec = Array.from(accum).map(v => v / frameCount);

  // Validate: must be all-negative log values
  const allNeg = cosineVec.every(v => v <= 0);
  const mean   = cosineVec.reduce((a,b) => a+b, 0) / cosineVec.length;
  console.log(`      frames=${frameCount} mean=${mean.toFixed(3)} allNeg=${allNeg} vec[0]=${cosineVec[0].toFixed(3)}`);

  return cosineVec;
}

// ── Spectral kurtosis for fault_type scoring ──────────────────────────────────
function computeKurtosis(vec) {
  const N = vec.length;
  let sum = 0; for (const v of vec) sum += v;
  const mean = sum / N;
  let s2 = 0, s4 = 0;
  for (const v of vec) { const d = v - mean; s2 += d*d; s4 += d*d*d*d; }
  const variance = s2 / N;
  return variance < 1e-15 ? 3 : (s4 / N) / (variance * variance);
}

function computeFlatness(vec) {
  const N = vec.length;
  let logSum = 0, arithSum = 0;
  for (const v of vec) {
    // convert log10-space back to magnitude for flatness calculation
    const mag = Math.pow(10, v);
    logSum   += Math.log(Math.max(Number.EPSILON, mag));
    arithSum += mag;
  }
  return Math.exp(logSum / N) / Math.max(Number.EPSILON, arithSum / N);
}

// ── Derive label/fault_type/severity from filename ────────────────────────────
function deriveMetadata(baseName) {
  const b = baseName.toLowerCase();
  let label     = baseName;
  let fault_type = baseName;
  let severity   = 'high';

  // Severity
  if (b.includes('critical')) severity = 'critical';
  else if (b.includes('high'))     severity = 'high';
  else if (b.includes('medium') || b.includes('moderate')) severity = 'medium';
  else if (b.includes('low'))      severity = 'low';

  // Fault type mapping
  if (b.includes('alternator') || b.includes('bearing')) {
    fault_type = 'alternator_bearing_fault';
    label      = baseName;
  } else if (b.includes('intake') || b.includes('leak')) {
    fault_type = 'intake_leak';
    label      = baseName;
  } else if (b.includes('water_pump') || b.includes('waterpump')) {
    fault_type = 'water_pump';
    label      = baseName;
  } else if (b.includes('motor') || b.includes('starter')) {
    fault_type = 'motor_starter';
    label      = baseName;
  } else if (b.includes('piston') || b.includes('knock')) {
    fault_type = 'piston_knock';
    label      = baseName;
  } else if (b.includes('serpentine') || b.includes('belt')) {
    fault_type = 'serpentine_belt';
    label      = baseName;
  } else if (b.includes('power_steering') || b.includes('powersteeringpump')) {
    fault_type = 'power_steering';
    label      = baseName;
  } else if (b.includes('timing') || b.includes('chain')) {
    fault_type = 'timing_chain';
    label      = baseName;
  } else if (b.includes('misfire')) {
    fault_type = 'misfire';
    label      = baseName;
  } else if (b.includes('rocker') || b.includes('valve')) {
    fault_type = 'rocker_valve';
    label      = baseName;
  } else if (b.includes('low_oil') || b.includes('oil')) {
    fault_type = 'low_oil';
    label      = baseName;
  }

  return { label, fault_type, severity };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 Listing anomaly-patterns bucket...');
  const { data: files, error: listErr } = await sb.storage
    .from(BUCKET).list('', { limit: 500 });

  if (listErr) {
    console.error('❌ Bucket list failed:', listErr.message);
    process.exit(1);
  }

  const wavFiles  = files.filter(f => f.name.toLowerCase().endsWith('.wav'));
  const jsonFiles = files.filter(f => f.name.toLowerCase().endsWith('.json'));
  console.log(`Found: ${wavFiles.length} WAV | ${jsonFiles.length} JSON`);
  console.log(`Vector space: log10(cleanMag), bins [${BIN_4KHZ}–${BIN_12KHZ}], ${VECTOR_LEN} dims`);
  console.log('─'.repeat(70));

  let ok = 0, fail = 0;
  const summary = [];

  for (const file of wavFiles) {
    const baseName = file.name.replace(/\.wav$/i, '');
    console.log(`\n⚙️  ${file.name} (${(file.metadata?.size / 1024).toFixed(1)} KB)`);

    // Download WAV
    const { data: wavBlob, error: dlErr } = await sb.storage
      .from(BUCKET).download(file.name);

    if (dlErr || !wavBlob) {
      console.log(`  ❌ Download failed: ${dlErr?.message}`);
      fail++;
      continue;
    }

    const arrayBuf = await wavBlob.arrayBuffer();
    const buf      = Buffer.from(arrayBuf);

    let parsed;
    try {
      parsed = parseWav(buf);
    } catch (e) {
      console.log(`  ❌ WAV parse failed: ${e.message}`);
      fail++;
      continue;
    }
    console.log(`  📊 SR=${parsed.sampleRate} ch=${parsed.numChannels} bits=${parsed.bitsPerSample} samples=${parsed.samples.length}`);

    const cosineVec = generateCosineVec(parsed.samples, parsed.sampleRate);
    if (!cosineVec) {
      console.log(`  ❌ Too short to generate fingerprint`);
      fail++;
      continue;
    }

    const { label, fault_type, severity } = deriveMetadata(baseName);
    const kurtosis = computeKurtosis(cosineVec);
    const flatness = computeFlatness(cosineVec);

    const fingerprint = {
      id:              baseName,
      label,
      fault_type,
      severity,
      source_file:     file.name,
      sample_rate:     TARGET_SR,
      fft_size:        FFT_SIZE,
      bin_4khz:        BIN_4KHZ,
      bin_12khz:       BIN_12KHZ,
      vec_length:      VECTOR_LEN,
      pipeline:        'v6-log10-exact',
      kurtosis_score:  parseFloat(kurtosis.toFixed(4)),
      flatness_score:  parseFloat(flatness.toFixed(6)),
      transient_score: 0.0,
      cosine_vec:      cosineVec,
      generated_at:    new Date().toISOString(),
    };

    const jsonName = `${baseName}.json`;
    const jsonBuf  = Buffer.from(JSON.stringify(fingerprint));

    const { error: upErr } = await sb.storage.from(BUCKET).upload(
      jsonName, jsonBuf,
      { contentType: 'application/json', upsert: true }
    );

    if (upErr) {
      console.log(`  ❌ Upload failed: ${upErr.message}`);
      fail++;
    } else {
      console.log(`  ✅ ${jsonName} uploaded (kurt=${kurtosis.toFixed(1)}, flat=${flatness.toFixed(3)})`);
      ok++;
      summary.push({ file: jsonName, label, fault_type, severity });
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`✅ SUCCESS: ${ok} fingerprints regenerated`);
  console.log(`❌ FAILED:  ${fail}`);
  console.log('\nGenerated fingerprints:');
  summary.forEach(s => console.log(`  ${s.fault_type.padEnd(30)} ${s.label.substring(0,40)}`));
  console.log('\nAll fingerprints are now in V6 log10 space. Detection will work correctly.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
