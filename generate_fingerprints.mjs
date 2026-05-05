/**
 * generate_fingerprints.mjs — Mechanical Audio Fingerprint Generator v2
 *
 * MUST be kept in sync with MechanicalAudioProcessor.worker.js.
 * Computes: cosine_vec, kurtosis_score, flatness_score, transient_score
 *
 * Usage:
 *   node generate_fingerprints.mjs            # normal (skips existing)
 *   node generate_fingerprints.mjs --force    # regenerates all files
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const FORCE       = process.argv.includes('--force');
const supabaseUrl = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const LOCAL_OUT   = './fingerprints';
const PIPELINE    = 'mechanical-v2';

const sb = createClient(supabaseUrl, supabaseKey);

// ─── MUST MATCH MechanicalAudioProcessor.worker.js ───────────────────────────
const TARGET_SR     = 44100;
const FFT_SIZE      = 4096;           // Frame = FFT = 93ms — NO data discarded
const FRAME_SAMPLES = FFT_SIZE;
const HOP_SAMPLES   = FFT_SIZE >> 1;  // 50% overlap
const BIN_3KHZ      = Math.round(3000  * FFT_SIZE / TARGET_SR);
const BIN_4KHZ      = Math.round(4000  * FFT_SIZE / TARGET_SR);
const BIN_8KHZ      = Math.round(8000  * FFT_SIZE / TARGET_SR);
const BIN_12KHZ     = Math.round(12000 * FFT_SIZE / TARGET_SR);

const FAULT_MAP = {
  'alternator_bearing_fault_critical': { fault_type: 'alternator_bearing_fault', severity: 'critical' },
  'BearingAlternator':                 { fault_type: 'alternator_bearing_fault', severity: 'high' },
  'engine_knocking_high':              { fault_type: 'engine_knock',             severity: 'high' },
  'exhaust_resonance_low':             { fault_type: 'exhaust_resonance',        severity: 'low' },
  'intake_leak_low':                   { fault_type: 'intake_leak',              severity: 'low' },
  'misfire_detected_medium':           { fault_type: 'misfire',                  severity: 'medium' },
  'MotorStarter':                      { fault_type: 'motor_starter',            severity: 'medium' },
  'Piston':                            { fault_type: 'piston_fault',             severity: 'high' },
  'PowerSteeringPump':                 { fault_type: 'power_steering',           severity: 'medium' },
  'pulley_misalignment_medium':        { fault_type: 'pulley_misalignment',      severity: 'medium' },
  'RockerArmAndValve':                 { fault_type: 'rocker_arm',               severity: 'high' },
  'SerpentineBelt':                    { fault_type: 'serpentine_belt',          severity: 'medium' },
  'timing_chain_rattle_high':          { fault_type: 'timing_chain',             severity: 'high' },
  'water_pump_failure_critical':       { fault_type: 'water_pump',               severity: 'critical' },
};

// ─── WAV Decoder ─────────────────────────────────────────────────────────────
function decodeWav(buffer) {
  const dv = new DataView(buffer);
  const numChannels  = dv.getUint16(22, true);
  const sampleRate   = dv.getUint32(24, true);
  const bitsPerSample = dv.getUint16(34, true);
  let dataOffset = 44;
  for (let i = 12; i < buffer.byteLength - 8; i++) {
    if (dv.getUint8(i)===0x64 && dv.getUint8(i+1)===0x61 && dv.getUint8(i+2)===0x74 && dv.getUint8(i+3)===0x61) {
      dataOffset = i + 8; break;
    }
  }
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((buffer.byteLength - dataOffset) / bytesPerSample / numChannels);
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const off = dataOffset + i * numChannels * bytesPerSample;
    let val = 0;
    if (bitsPerSample === 16)      val = dv.getInt16(off, true) / 32768.0;
    else if (bitsPerSample === 32) val = dv.getFloat32(off, true);
    else if (bitsPerSample === 8)  val = (dv.getUint8(off) - 128) / 128.0;
    samples[i] = val;
  }
  return { samples, sampleRate, numChannels };
}

// ─── DSP (identical to MechanicalAudioProcessor.worker.js) ───────────────────
function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr, newLen = Math.floor(signal.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, l = Math.floor(idx), r = Math.min(l+1, signal.length-1);
    out[i] = signal[l]*(1-(idx-l)) + signal[r]*(idx-l);
  }
  return out;
}

function peakNormalize(signal) {
  let maxVal = 0;
  for (let i = 0; i < signal.length; i++) { const a = Math.abs(signal[i]); if (a > maxVal) maxVal = a; }
  if (maxVal < 1e-8) return signal;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] / maxVal;
  return out;
}

function applyHanning(signal, N) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = signal[i] * (0.5 * (1 - Math.cos((2*Math.PI*i)/(N-1))));
  return out;
}

function computeFFT(signal, N) {
  const re = new Float32Array(N), im = new Float32Array(N);
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
    const ang = -2*Math.PI/len, wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cRe=1, cIm=0;
      for (let k = 0; k < len/2; k++) {
        const uRe=re[i+k],uIm=im[i+k],vRe=re[i+k+len/2]*cRe-im[i+k+len/2]*cIm,vIm=re[i+k+len/2]*cIm+im[i+k+len/2]*cRe;
        re[i+k]=uRe+vRe;im[i+k]=uIm+vIm;re[i+k+len/2]=uRe-vRe;im[i+k+len/2]=uIm-vIm;
        const nRe=cRe*wRe-cIm*wIm; cIm=cRe*wIm+cIm*wRe; cRe=nRe;
      }
    }
  }
  return { re, im };
}

function computeSpectralKurtosis(power, binStart, binEnd) {
  const N = binEnd - binStart;
  if (N <= 0) return 3;
  let sum = 0;
  for (let i = binStart; i < binEnd; i++) sum += Math.max(Number.EPSILON, power[i]);
  const mean = sum / N;
  let sum2=0, sum4=0;
  for (let i = binStart; i < binEnd; i++) { const d = Math.max(Number.EPSILON, power[i]) - mean; sum2+=d*d; sum4+=d*d*d*d; }
  const variance = sum2 / N;
  return variance < Number.EPSILON ? 3 : (sum4/N)/(variance*variance);
}

function computeSpectralFlatness(power, binStart, binEnd) {
  const N = binEnd - binStart;
  if (N <= 0) return 0;
  let logSum=0, arithSum=0;
  for (let i = binStart; i < binEnd; i++) { const p=Math.max(Number.EPSILON, power[i]); logSum+=Math.log(p); arithSum+=p; }
  return Math.exp(logSum/N) / Math.max(Number.EPSILON, arithSum/N);
}

function computeTransientScore(samples) {
  const STE_BLOCK = Math.round(TARGET_SR * 0.01);
  const ste = [];
  for (let i = 0; i + STE_BLOCK <= samples.length; i += STE_BLOCK) {
    let sq = 0;
    for (let j = i; j < i + STE_BLOCK; j++) sq += samples[j]*samples[j];
    ste.push(sq / STE_BLOCK);
  }
  if (ste.length < 2) return 0;
  let maxDeriv=0, totalSte=0;
  for (let i = 1; i < ste.length; i++) { const d=ste[i]-ste[i-1]; if (d>maxDeriv) maxDeriv=d; totalSte+=ste[i]; }
  return maxDeriv / (totalSte/(ste.length-1) + Number.EPSILON);
}

/**
 * Compute all features for a normalized mono PCM array.
 */
function computeAllFeatures(pcm) {
  const frameVecs     = [];
  const frameKurtoses = [];
  const frameFlatnesses = [];
  const HOP = HOP_SAMPLES;

  for (let offset = 0; offset + FRAME_SAMPLES <= pcm.length; offset += HOP) {
    const frame    = pcm.slice(offset, offset + FRAME_SAMPLES);
    const windowed = applyHanning(frame, FRAME_SAMPLES);
    const { re, im } = computeFFT(windowed, FFT_SIZE);

    const power  = new Float32Array(FFT_SIZE / 2);
    const logMag = new Float32Array(FFT_SIZE / 2);
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      const mag = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
      power[i]  = mag * mag;
      logMag[i] = Math.log10(Math.max(Number.EPSILON, mag));
    }

    frameVecs.push(Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ)));
    frameKurtoses.push(computeSpectralKurtosis(power, BIN_3KHZ, BIN_8KHZ));
    frameFlatnesses.push(computeSpectralFlatness(power, BIN_8KHZ, BIN_12KHZ));
  }

  // Handle tail
  if (pcm.length % FRAME_SAMPLES !== 0) {
    const tail = new Float32Array(FRAME_SAMPLES);
    tail.set(pcm.slice(Math.max(0, pcm.length - FRAME_SAMPLES)));
    const windowed = applyHanning(tail, FRAME_SAMPLES);
    const { re, im } = computeFFT(windowed, FFT_SIZE);
    const power  = new Float32Array(FFT_SIZE / 2);
    const logMag = new Float32Array(FFT_SIZE / 2);
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      const mag = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
      power[i]  = mag * mag;
      logMag[i] = Math.log10(Math.max(Number.EPSILON, mag));
    }
    frameVecs.push(Array.from(logMag.slice(BIN_4KHZ, BIN_12KHZ)));
    frameKurtoses.push(computeSpectralKurtosis(power, BIN_3KHZ, BIN_8KHZ));
    frameFlatnesses.push(computeSpectralFlatness(power, BIN_8KHZ, BIN_12KHZ));
  }

  if (frameVecs.length === 0) return null;

  const vecLen = frameVecs[0].length;
  const avgVec = new Array(vecLen).fill(0);
  for (const v of frameVecs) for (let i = 0; i < vecLen; i++) avgVec[i] += v[i];
  for (let i = 0; i < vecLen; i++) avgVec[i] /= frameVecs.length;

  const avgKurtosis = frameKurtoses.reduce((a, b) => a + b, 0) / frameKurtoses.length;
  const avgFlatness = frameFlatnesses.reduce((a, b) => a + b, 0) / frameFlatnesses.length;
  const transient   = computeTransientScore(Array.from(pcm));

  return { cosine_vec: avgVec, kurtosis_score: avgKurtosis, flatness_score: avgFlatness, transient_score: transient };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Listing anomaly-patterns bucket... ${FORCE ? '(--force: regenerating all)' : ''}`);
  const { data: files, error: listErr } = await sb.storage.from('anomaly-patterns').list('', { limit: 200 });
  if (listErr) { console.error('List error:', listErr.message); process.exit(1); }

  const wavFiles = files.filter(f => f.name.endsWith('.wav'));
  console.log(`Found ${wavFiles.length} WAV files.\n`);

  for (const file of wavFiles) {
    const baseName = file.name.replace(/\.wav$/, '');
    const jsonName = `${baseName}.json`;
    const localPath = path.join(LOCAL_OUT, jsonName);

    // In non-force mode, skip if local JSON already has this pipeline version
    if (!FORCE && fs.existsSync(localPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        if (existing.pipeline === PIPELINE) { console.log(`⏭  ${jsonName} up-to-date — skipping.`); continue; }
      } catch (_) {}
    }

    console.log(`🔄 Processing ${file.name}...`);
    const { data: fileData, error: dlErr } = await sb.storage.from('anomaly-patterns').download(file.name);
    if (dlErr || !fileData) { console.error(`  ❌ Download failed: ${dlErr?.message}`); continue; }

    try {
      const arrayBuffer = await fileData.arrayBuffer();
      const { samples, sampleRate, numChannels } = decodeWav(arrayBuffer);

      let mono;
      if (numChannels === 1) {
        mono = samples;
      } else {
        mono = new Float32Array(Math.floor(samples.length / numChannels));
        for (let i = 0; i < mono.length; i++) {
          let s = 0;
          for (let c = 0; c < numChannels; c++) s += samples[i*numChannels+c];
          mono[i] = s / numChannels;
        }
      }

      const normalized = peakNormalize(linearResample(mono, sampleRate, TARGET_SR));
      const features   = computeAllFeatures(normalized);
      if (!features) { console.error(`  ❌ Empty audio — skipping.`); continue; }

      const meta = FAULT_MAP[baseName] || { fault_type: baseName, severity: 'medium' };

      const fingerprint = {
        id:              baseName,
        label:           baseName,
        fault_type:      meta.fault_type,
        severity:        meta.severity,
        source_file:     file.name,
        cosine_vec:      features.cosine_vec,
        kurtosis_score:  features.kurtosis_score,
        flatness_score:  features.flatness_score,
        transient_score: features.transient_score,
        generated_at:    new Date().toISOString(),
        pipeline:        PIPELINE,
        fft_size:        FFT_SIZE,
        frame_samples:   FRAME_SAMPLES,
        sample_rate:     TARGET_SR,
        vec_length:      features.cosine_vec.length,
      };

      if (!fs.existsSync(LOCAL_OUT)) fs.mkdirSync(LOCAL_OUT, { recursive: true });
      fs.writeFileSync(localPath, JSON.stringify(fingerprint, null, 2));
      console.log(`  💾 ${jsonName} | kurt=${features.kurtosis_score.toFixed(2)} | flat=${features.flatness_score.toFixed(3)} | transient=${features.transient_score.toFixed(3)}`);

      const jsonBytes = new TextEncoder().encode(JSON.stringify(fingerprint));
      const jsonBlob  = new Blob([jsonBytes], { type: 'application/json' });
      const { error: uploadErr } = await sb.storage.from('anomaly-patterns').upload(jsonName, jsonBlob, { contentType: 'application/json', upsert: true });
      if (uploadErr) console.warn(`  ⚠️  Upload failed (${uploadErr.message}) — local file saved.`);
      else           console.log(`  ✅ Uploaded to Supabase.`);

    } catch (err) {
      console.error(`  ❌ Error processing ${file.name}:`, err.message);
    }
  }

  console.log('\n✅ Done. Upload any failed files manually from ./fingerprints/');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
