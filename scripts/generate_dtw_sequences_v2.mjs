/**
 * generate_dtw_sequences_v2.mjs — V15-aligned sequence generator
 * 
 * Generates DTW fingerprints using the EXACT same 18-dim feature extraction
 * as AudioV8_SequenceProcessor.worker.js v15. This ensures preprocessing parity.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const BUCKET = 'anomaly-patterns';
const OUTPUT = path.join(__dirname, '..', 'src', 'data', 'dtwFingerprints.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TARGET_SR = 16000;
const FFT_SIZE = 512;
const HOP = 320;
const N_MELS = 40;
const N_MFCC = 13;
const SEQ_LENGTH = 50;

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

let _cachedFB = null;
function getMelFilterbank(sr) {
  if (_cachedFB) return _cachedFB;
  const fftBins = FFT_SIZE / 2 + 1;
  const melMax = 2595 * Math.log10(1 + (sr / 2) / 700);
  const melPts = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) melPts[i] = i * melMax / (N_MELS + 1);
  const hzPts = new Float32Array(N_MELS + 2);
  const binPts = new Int32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    hzPts[i] = 700 * (Math.pow(10, melPts[i] / 2595) - 1);
    binPts[i] = Math.floor((FFT_SIZE + 1) * hzPts[i] / sr);
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
  _cachedFB = { fb, bw };
  return { fb, bw };
}

// EXACT same standardization as the worker: standardize ONLY the first 14 dims
function standardizeSequence(seq) {
  const numFrames = seq.length;
  const dims = 14; // Only MFCC(13) + Flux(1)
  const stdSeq = [];
  
  // Compute mean/std per dimension
  for (let f = 0; f < numFrames; f++) stdSeq.push(new Array(seq[f].length));
  
  for (let d = 0; d < dims; d++) {
    let sum = 0, sumSq = 0;
    for (let f = 0; f < numFrames; f++) { sum += seq[f][d]; sumSq += seq[f][d] * seq[f][d]; }
    const mean = sum / numFrames;
    const std = Math.max(1.0, Math.sqrt(Math.max(0, (sumSq / numFrames) - mean * mean)));
    for (let f = 0; f < numFrames; f++) stdSeq[f][d] = (seq[f][d] - mean) / std;
  }
  // Copy remaining dims raw
  for (let f = 0; f < numFrames; f++) {
    for (let d = dims; d < seq[f].length; d++) stdSeq[f][d] = seq[f][d];
  }
  return stdSeq;
}

function extractAndStandardize(pcm16k) {
  const { fb, bw } = getMelFilterbank(TARGET_SR);
  const hann = getHannWindow(FFT_SIZE);
  const fftBins = FFT_SIZE / 2 + 1;
  const reFFT = new Float32Array(FFT_SIZE), imFFT = new Float32Array(FFT_SIZE);
  let prevMag = new Float32Array(fftBins);
  
  const numFrames = Math.floor((pcm16k.length - FFT_SIZE) / HOP);
  const rawSequence = [];
  
  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP;
    
    // Compute per-frame features EXACTLY matching the worker
    let frameEnergySq = 0, zcr = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = pcm16k[start + i] || 0;
      frameEnergySq += s * s;
      reFFT[i] = s * hann[i];
      imFFT[i] = 0;
      if (i > 0 && ((s >= 0) !== ((pcm16k[start + i - 1] || 0) >= 0))) zcr++;
    }
    const rms = Math.sqrt(frameEnergySq / FFT_SIZE);
    const zcrNorm = zcr / FFT_SIZE;
    
    fftInPlace(reFFT, imFFT);
    
    let flux = 0, gmLog = 0, amSum = 0, centroidNum = 0, centroidDen = 0;
    const melEnergies = new Float64Array(N_MELS);
    
    for (let k = 0; k < fftBins; k++) {
      const mag = Math.sqrt(reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k]);
      flux += Math.max(0, mag - prevMag[k]);
      prevMag[k] = mag;
      if (k > 0) { gmLog += Math.log(mag + 1e-10); amSum += mag; }
      const freq = k * TARGET_SR / FFT_SIZE;
      centroidNum += freq * mag;
      centroidDen += mag;
      for (let m = 0; m < N_MELS; m++) melEnergies[m] += fb[m][k] * mag;
    }
    
    const gm = Math.exp(gmLog / (fftBins - 1));
    const am = (amSum / (fftBins - 1)) + 1e-10;
    const flatness = gm / am;
    const centroid = centroidDen > 1e-10 ? (centroidNum / centroidDen) / (TARGET_SR / 2) : 0;
    
    for (let m = 0; m < N_MELS; m++) melEnergies[m] = Math.log(Math.max(melEnergies[m] / bw[m], 1e-10));
    
    const mfcc = new Float64Array(N_MFCC);
    for (let k = 0; k < N_MFCC; k++) {
      let sum = 0;
      for (let m = 0; m < N_MELS; m++) sum += melEnergies[m] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
      mfcc[k] = sum;
    }
    
    // 18 features matching the worker EXACTLY
    const frame = new Array(18);
    for (let i = 0; i < N_MFCC; i++) frame[i] = mfcc[i];
    frame[13] = Math.log10(1 + flux);
    frame[14] = rms;
    frame[15] = flatness;
    frame[16] = zcrNorm;
    frame[17] = centroid;
    
    rawSequence.push(frame);
  }
  
  // Take best 50 frames
  let bestStart = 0;
  if (rawSequence.length > SEQ_LENGTH) {
    let maxEnergy = -1;
    for (let i = 0; i <= rawSequence.length - SEQ_LENGTH; i++) {
      let energy = 0;
      for (let j = 0; j < SEQ_LENGTH; j++) energy += rawSequence[i+j][14]; // RMS
      if (energy > maxEnergy) { maxEnergy = energy; bestStart = i; }
    }
  }
  const cropped = rawSequence.slice(bestStart, bestStart + SEQ_LENGTH);
  
  // Standardize ONLY first 14 dims (matching worker)
  return standardizeSequence(cropped);
}

function parseWav(buffer) {
  const view = new DataView(buffer.buffer || buffer);
  const audioFormat = view.getUint16(20, true);
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  let pos = 12, dataOffset = -1, dataSize = 0;
  while (pos < view.byteLength - 8) {
    const id = String.fromCharCode(view.getUint8(pos), view.getUint8(pos+1), view.getUint8(pos+2), view.getUint8(pos+3));
    let sz = view.getUint32(pos + 4, true);
    if (id === 'data') { dataOffset = pos + 8; dataSize = sz; break; }
    if (sz === 0 || sz > view.byteLength) sz = 4;
    pos += 8 + sz + (sz % 2);
  }
  if (dataOffset === -1) throw new Error('Data chunk not found');
  const bps = bitsPerSample / 8;
  const numSamples = Math.floor(dataSize / (bps * numChannels));
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    let mono = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const bp = dataOffset + (i * numChannels + ch) * bps;
      if (bp + bps > view.byteLength) break;
      let s = 0;
      if (audioFormat === 3 && bitsPerSample === 32) s = view.getFloat32(bp, true);
      else if (bitsPerSample === 16) s = view.getInt16(bp, true) / 32768;
      else if (bitsPerSample === 8) s = (view.getUint8(bp) - 128) / 128;
      mono += s;
    }
    samples[i] = mono / numChannels;
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
  else if (b.includes('medium') || b.includes('moderate')) severity = 'medium';
  else if (b.includes('low')) severity = 'low';
  if (b.includes('alternator') || (b.includes('bearing') && !b.includes('water'))) fault_type = 'alternator_bearing_fault';
  else if (b.includes('intake') || b.includes('leak')) fault_type = 'intake_leak';
  else if (b.includes('water_pump') || b.includes('waterpump')) fault_type = 'water_pump';
  else if (b.includes('motor') || b.includes('starter')) fault_type = 'motor_starter';
  else if (b.includes('piston') || b.includes('knock')) fault_type = 'piston_knock';
  else if (b.includes('serpentine') || (b.includes('belt') && !b.includes('power'))) fault_type = 'serpentine_belt';
  else if (b.includes('power_steering') || b.includes('powersteeringpump') || b.includes('powersteer')) fault_type = 'power_steering';
  else if (b.includes('timing') || b.includes('chain')) fault_type = 'timing_chain';
  else if (b.includes('rocker') || b.includes('valve')) fault_type = 'rocker_valve';
  else if (b.includes('low_oil') || b.includes('oil')) fault_type = 'low_oil';
  const label = baseName.replace(/_failure_type_\d+$/, '').replace(/_failure_0*\d+$/, '').replace(/_\d+$/, '').replace(/_/g, ' ')
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { fault_type, severity, label };
}

async function main() {
  console.log('🔍 Listing anomaly-patterns bucket...');
  const { data: files } = await supabase.storage.from(BUCKET).list('', { limit: 500 });
  const wavFiles = files.filter(f => f.name.toLowerCase().endsWith('.wav') && !f.name.toLowerCase().includes('issue_with'));
  console.log(`Found ${wavFiles.length} clean WAV files.`);

  const embedded = [];
  for (const file of wavFiles) {
    console.log(`📥 Processing: ${file.name}`);
    const { data: wavData } = await supabase.storage.from(BUCKET).download(file.name);
    if (!wavData) continue;
    const buf = Buffer.from(await wavData.arrayBuffer());
    let parsed;
    try { parsed = parseWav(buf); } catch (e) { console.error(`  ❌ ${e.message}`); continue; }
    const pcm16k = parsed.sampleRate === TARGET_SR ? parsed.samples : linearResample(parsed.samples, parsed.sampleRate, TARGET_SR);
    const seq = extractAndStandardize(pcm16k);
    const baseName = file.name.replace(/\.wav$/i, '');
    const meta = deriveMetadata(baseName);
    embedded.push({
      id: baseName, label: meta.label, fault_type: meta.fault_type,
      severity: meta.severity, source_file: file.name,
      dtw_sequence: seq
    });
    console.log(`  ✅ ${seq.length} frames, ${seq[0].length} dims`);
  }

  const jsContent = `/**
 * dtwFingerprints.js — AUTO-GENERATED (V15-aligned)
 * Pipeline: v15-dtw-sequence-18dim
 * Format: 18-dim standardized sequence (13 MFCC + Flux + RMS + Flatness + ZCR + Centroid)
 * Only first 14 dims are standardized (matching worker behavior)
 */
export const DTW_FINGERPRINTS = ${JSON.stringify(embedded)};
`;
  fs.writeFileSync(OUTPUT, jsContent);
  console.log(`\n🎉 Generated dtwFingerprints.js with ${embedded.length} sequences (V15-aligned).`);
}

main();
