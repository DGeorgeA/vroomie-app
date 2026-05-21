import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
// Use anon key for reading
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const BUCKET = 'anomaly-patterns';
const OUTPUT = path.join(__dirname, '..', 'src', 'data', 'embeddedFingerprints.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TARGET_SR = 16000;
const N_FFT = 512;
const HOP = 160;
const N_MELS = 64;
const N_MFCC = 13;

function getHannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (size - 1));
  return w;
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, wAngle = (2 * Math.PI) / len;
    const wRe = Math.cos(wAngle), wIm = Math.sin(wAngle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const tRe = curRe * re[i+j+half] - curIm * im[i+j+half];
        const tIm = curRe * im[i+j+half] + curIm * re[i+j+half];
        re[i+j+half] = re[i+j] - tRe; im[i+j+half] = im[i+j] - tIm;
        re[i+j] += tRe; im[i+j] += tIm;
        const nCurRe = curRe * wRe - curIm * wIm; curIm = curRe * wIm + curIm * wRe; curRe = nCurRe;
      }
    }
  }
}

let _cachedFB = null, _cachedFBsr = -1;
function getMelFilterbank(sr) {
  if (_cachedFB && _cachedFBsr === sr) return _cachedFB;
  const fftBins = N_FFT / 2 + 1;
  const melMax = 2595 * Math.log10(1 + (sr / 2) / 700);
  const melPts = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) melPts[i] = i * melMax / (N_MELS + 1);
  const hzPts = new Float32Array(N_MELS + 2);
  const binPts = new Int32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    hzPts[i] = 700 * (Math.pow(10, melPts[i] / 2595) - 1);
    binPts[i] = Math.floor((N_FFT + 1) * hzPts[i] / sr);
  }
  const fb = []; const bw = new Float32Array(N_MELS);
  for (let m = 0; m < N_MELS; m++) {
    const f = new Float32Array(fftBins);
    const lo = binPts[m], cen = binPts[m+1], hi = binPts[m+2];
    bw[m] = Math.max(1, hi - lo);
    for (let k = lo; k < cen && k < fftBins; k++) f[k] = cen > lo ? (k - lo) / (cen - lo) : 0;
    for (let k = cen; k <= hi && k < fftBins; k++) f[k] = hi > cen ? (hi - k) / (hi - cen) : 0;
    fb.push(f);
  }
  _cachedFB = { fb, bw }; _cachedFBsr = sr;
  return { fb, bw };
}

function l2Norm(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
  n = Math.sqrt(n) || 1e-10;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
  return out;
}

function computeCompositeEmbedding(samples, sr) {
  const { fb, bw } = getMelFilterbank(sr);
  const hann = getHannWindow(N_FFT);
  const fftBins = N_FFT / 2 + 1;
  const numFrames = Math.max(1, Math.floor((samples.length - N_FFT) / HOP));
  
  const melHistory = Array.from({ length: N_MELS }, () => new Float64Array(numFrames));
  const mfccHistory = Array.from({ length: N_MFCC }, () => new Float64Array(numFrames));
  const fluxHistory = new Float64Array(numFrames);
  const crestHistory = new Float64Array(numFrames);

  let totalZCR = 0, totalRMS = 0, totalCentroid = 0;
  const reFFT = new Float32Array(N_FFT), imFFT = new Float32Array(N_FFT);
  let prevMag = new Float32Array(fftBins);

  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP;
    for (let i = 0; i < N_FFT; i++) { reFFT[i] = (samples[start + i] || 0) * hann[i]; imFFT[i] = 0; }
    fftInPlace(reFFT, imFFT);
    
    let frameRMS = 0, weightedSum = 0, powerSum = 0;
    let maxMag = 0, flux = 0;

    for (let k = 0; k < fftBins; k++) {
      const mag = Math.sqrt(reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k]);
      if (mag > maxMag) maxMag = mag;
      flux += Math.max(0, mag - prevMag[k]);
      prevMag[k] = mag;

      frameRMS += reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k];
      weightedSum += k * mag; powerSum += mag;
      for (let m = 0; m < N_MELS; m++) melHistory[m][f] += fb[m][k] * mag;
    }
    
    fluxHistory[f] = flux;
    const rms = Math.sqrt(frameRMS / fftBins);
    totalRMS += rms;
    crestHistory[f] = rms > 0 ? maxMag / rms : 0;
    
    totalCentroid += powerSum > 0 ? (weightedSum / powerSum) / fftBins : 0;
    let zcr = 0;
    for (let i = 1; i < N_FFT; i++) if ((samples[start + i] >= 0) !== (samples[start + i - 1] >= 0)) zcr++;
    totalZCR += zcr / N_FFT;
    
    for (let m = 0; m < N_MELS; m++) melHistory[m][f] = Math.log(Math.max(melHistory[m][f] / bw[m], 1e-10));
    for (let k = 0; k < N_MFCC; k++) {
      let sum = 0;
      for (let m = 0; m < N_MELS; m++) sum += melHistory[m][f] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
      mfccHistory[k][f] = sum;
    }
  }

  const deltaMfccHistory = Array.from({ length: N_MFCC }, () => new Float64Array(numFrames));
  for (let k = 0; k < N_MFCC; k++) {
    for (let f = 1; f < numFrames - 1; f++) {
      deltaMfccHistory[k][f] = (mfccHistory[k][f+1] - mfccHistory[k][f-1]) / 2;
    }
  }

  const melMean = new Float64Array(N_MELS), melSD = new Float64Array(N_MELS);
  const mfccMean = new Float64Array(N_MFCC), mfccSD = new Float64Array(N_MFCC);
  const dMfccMean = new Float64Array(N_MFCC), dMfccSD = new Float64Array(N_MFCC);
  
  let fluxMean = 0, fluxMax = 0, crestMean = 0, crestMax = 0;
  for (let f = 0; f < numFrames; f++) {
    fluxMean += fluxHistory[f];
    if (fluxHistory[f] > fluxMax) fluxMax = fluxHistory[f];
    crestMean += crestHistory[f];
    if (crestHistory[f] > crestMax) crestMax = crestHistory[f];
  }
  fluxMean /= numFrames; crestMean /= numFrames;

  for (let m = 0; m < N_MELS; m++) {
    let sum = 0, sumSq = 0;
    for (let f = 0; f < numFrames; f++) { sum += melHistory[m][f]; sumSq += melHistory[m][f] * melHistory[m][f]; }
    melMean[m] = sum / numFrames; melSD[m] = Math.sqrt(Math.max(0, (sumSq / numFrames) - melMean[m] * melMean[m]));
  }
  
  for (let k = 0; k < N_MFCC; k++) {
    let sum = 0, sumSq = 0, dSum = 0, dSumSq = 0;
    for (let f = 0; f < numFrames; f++) { 
      sum += mfccHistory[k][f]; sumSq += mfccHistory[k][f] * mfccHistory[k][f]; 
      dSum += deltaMfccHistory[k][f]; dSumSq += deltaMfccHistory[k][f] * deltaMfccHistory[k][f]; 
    }
    mfccMean[k] = sum / numFrames; mfccSD[k] = Math.sqrt(Math.max(0, (sumSq / numFrames) - mfccMean[k] * mfccMean[k]));
    dMfccMean[k] = dSum / numFrames; dMfccSD[k] = Math.sqrt(Math.max(0, (dSumSq / numFrames) - dMfccMean[k] * dMfccMean[k]));
  }

  const transientFeatures = new Float32Array(8);
  transientFeatures[0] = Math.min(1.0, (totalRMS / numFrames) * 1.5);
  transientFeatures[1] = Math.min(1.0, (totalZCR / numFrames) * 2.0);
  transientFeatures[2] = Math.min(1.0, (totalCentroid / numFrames) * 1.2);
  transientFeatures[3] = Math.min(1.0, fluxMean * 0.1);
  transientFeatures[4] = Math.min(1.0, fluxMax * 0.05);
  transientFeatures[5] = Math.min(1.0, crestMean * 0.1);
  transientFeatures[6] = Math.min(1.0, crestMax * 0.05);
  transientFeatures[7] = crestMax > crestMean * 3 ? 1.0 : 0.0;

  const raw = new Float32Array(N_MELS * 2 + N_MFCC * 4 + 8);
  let offset = 0;
  raw.set(l2Norm(melMean), offset); offset += N_MELS;
  raw.set(l2Norm(melSD), offset); offset += N_MELS;
  raw.set(l2Norm(mfccMean), offset); offset += N_MFCC;
  raw.set(l2Norm(mfccSD), offset); offset += N_MFCC;
  raw.set(l2Norm(dMfccMean), offset); offset += N_MFCC;
  raw.set(l2Norm(dMfccSD), offset); offset += N_MFCC;
  raw.set(l2Norm(transientFeatures), offset);
  
  return l2Norm(raw);
}

function parseWav(buffer) {
  const view = new DataView(buffer.buffer || buffer);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a WAV file');

  const audioFormat   = view.getUint16(20, true);
  const numChannels   = view.getUint16(22, true);
  const sampleRate    = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  if (audioFormat !== 1 && audioFormat !== 3) throw new Error(`Unsupported format ${audioFormat}`);

  let pos = 12;
  let dataOffset = -1;
  let dataSize = 0;
  while (pos < view.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(pos), view.getUint8(pos+1),
      view.getUint8(pos+2), view.getUint8(pos+3)
    );
    let chunkSize = view.getUint32(pos + 4, true);
    if (chunkId === 'data') {
      dataOffset = pos + 8;
      dataSize = chunkSize;
      break;
    }
    if (chunkSize === 0 || chunkSize > view.byteLength) chunkSize = 4;
    pos += 8 + chunkSize + (chunkSize % 2);
  }
  
  if (dataOffset === -1) throw new Error('Data chunk not found');

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataSize / (bytesPerSample * numChannels));
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    let monoSample = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const bp = dataOffset + (i * numChannels + ch) * bytesPerSample;
      if (bp + bytesPerSample > view.byteLength) break;
      let s = 0;
      if (audioFormat === 3 && bitsPerSample === 32) s = view.getFloat32(bp, true);
      else if (bitsPerSample === 16) s = view.getInt16(bp, true) / 32768;
      else if (bitsPerSample === 8) s = (view.getUint8(bp) - 128) / 128;
      monoSample += s;
    }
    samples[i] = monoSample / numChannels;
  }
  return { samples, sampleRate };
}

function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr;
  const newLen = Math.floor(signal.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, l = Math.floor(idx), r = Math.min(l + 1, signal.length - 1);
    out[i] = signal[l] * (1 - (idx - l)) + signal[r] * (idx - l);
  }
  return out;
}

function deriveMetadata(baseName) {
  const b = baseName.toLowerCase();
  let fault_type = 'unknown', severity = 'high';

  if (b.includes('critical')) severity = 'critical';
  else if (b.includes('medium')||b.includes('moderate')) severity = 'medium';
  else if (b.includes('low')) severity = 'low';

  if (b.includes('alternator')||(b.includes('bearing')&&!b.includes('water'))) fault_type='alternator_bearing_fault';
  else if (b.includes('intake')||b.includes('leak')) fault_type='intake_leak';
  else if (b.includes('water_pump')||b.includes('waterpump')) fault_type='water_pump';
  else if (b.includes('motor')||b.includes('starter')) fault_type='motor_starter';
  else if (b.includes('piston')||b.includes('knock')) fault_type='piston_knock';
  else if (b.includes('serpentinebelt')||b.includes('serpentine')||(b.includes('belt')&&!b.includes('power'))) fault_type='serpentine_belt';
  else if (b.includes('power_steering')||b.includes('powersteeringpump')||b.includes('powersteer')) fault_type='power_steering';
  else if (b.includes('timing')||b.includes('chain')) fault_type='timing_chain';
  else if (b.includes('rocker')||b.includes('valve')) fault_type='rocker_valve';
  else if (b.includes('low_oil')||b.includes('oil')) fault_type='low_oil';

  const displayLabel = baseName
    .replace(/_failure_type_\d+$/, '')
    .replace(/_failure_0*\d+$/, '')
    .replace(/_\d+$/, '')
    .replace(/_/g, ' ')
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  return { fault_type, severity, label: displayLabel };
}

async function main() {
  console.log('🔍 Listing anomaly-patterns bucket...');
  const { data: files, error } = await supabase.storage.from(BUCKET).list('', { limit: 500 });
  if (error) { console.error('List error:', error); return; }

  const wavFiles = files.filter(f => f.name.toLowerCase().endsWith('.wav'));
  console.log(`Found ${wavFiles.length} WAV files.`);

  const embedded = [];

  for (const file of wavFiles) {
    console.log(`📥 Processing: ${file.name}`);
    const { data: wavData } = await supabase.storage.from(BUCKET).download(file.name);
    if (!wavData) continue;

    const arrayBuf = await wavData.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    
    let parsed;
    try { parsed = parseWav(buf); } catch (e) { console.error(`  ❌ Parse failed: ${e.message}`); continue; }

    const pcm16k = parsed.sampleRate === 16000 ? parsed.samples : linearResample(parsed.samples, parsed.sampleRate, 16000);
    const emb = computeCompositeEmbedding(pcm16k, 16000);

    const baseName = file.name.replace(/\.wav$/i, '');
    const meta = deriveMetadata(baseName);

    embedded.push({
      id: baseName,
      label: meta.label,
      fault_type: meta.fault_type,
      severity: meta.severity,
      source_file: file.name,
      cosine_vec: Array.from(emb)
    });
    console.log(`  ✅ Embedded 188-dim vector.`);
  }

  const jsContent = `/**
 * embeddedFingerprints.js — AUTO-GENERATED by generate_v7_fingerprints.mjs
 * 
 * Pipeline: v7-mel-mfcc-advanced
 * Vector space: 188-dim L2-normalized Mel/MFCC/Transient vector
 * Generated: ${new Date().toISOString()}
 * 
 * DO NOT EDIT MANUALLY.
 */

export const EMBEDDED_FINGERPRINTS = ${JSON.stringify(embedded)};
`;

  fs.writeFileSync(OUTPUT, jsContent);
  console.log(`\n🎉 Successfully generated embeddedFingerprints.js with ${embedded.length} entries.`);
}

main();
