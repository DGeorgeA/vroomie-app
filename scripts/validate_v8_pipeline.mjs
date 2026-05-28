/**
 * validate_v8_pipeline.mjs — BMAD MEASURE Phase
 * 
 * Downloads ALL Supabase anomaly references + generates synthetic test signals.
 * Runs each through the EXACT same feature extraction and classification pipeline
 * as AudioV8_SequenceProcessor.worker.js. Prints real numbers for calibration.
 */
import { createClient } from '@supabase/supabase-js';
import { DTW_FINGERPRINTS } from '../src/data/dtwFingerprints.js';

const SUPABASE_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const BUCKET = 'anomaly-patterns';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TARGET_SR = 16000;
const FFT_SIZE = 512;
const HOP = 320;
const N_MELS = 40;
const N_MFCC = 13;
const SEQ_LENGTH = 50;

// ── DSP Functions (exact copy from worker) ──────────────────
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

function parseWav(buffer) {
  const view = new DataView(buffer.buffer || buffer);
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const audioFormat = view.getUint16(20, true);
  let pos = 12, dataOffset = -1, dataSize = 0;
  while (pos < view.byteLength - 8) {
    const id = String.fromCharCode(view.getUint8(pos), view.getUint8(pos+1), view.getUint8(pos+2), view.getUint8(pos+3));
    let sz = view.getUint32(pos + 4, true);
    if (id === 'data') { dataOffset = pos + 8; dataSize = sz; break; }
    if (sz === 0 || sz > view.byteLength) sz = 4;
    pos += 8 + sz + (sz % 2);
  }
  if (dataOffset === -1) throw new Error('No data chunk');
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

// ── Feature extraction (exact copy from worker) ─────────────
function extractFeatureSequence(pcm16k) {
  const { fb, bw } = getMelFilterbank(TARGET_SR);
  const hann = getHannWindow(FFT_SIZE);
  const fftBins = FFT_SIZE / 2 + 1;
  const reFFT = new Float32Array(FFT_SIZE), imFFT = new Float32Array(FFT_SIZE);
  let prevMag = new Float32Array(fftBins);
  
  const numFrames = Math.floor((pcm16k.length - FFT_SIZE) / HOP);
  const sequence = [];
  
  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP;
    
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
    
    // 18 features: 13 MFCC + flux + rms + flatness + zcr + centroid
    const frame = new Array(18);
    for (let i = 0; i < N_MFCC; i++) frame[i] = mfcc[i];
    frame[13] = Math.log10(1 + flux);
    frame[14] = rms;
    frame[15] = flatness;
    frame[16] = zcrNorm;
    frame[17] = centroid;
    
    sequence.push(frame);
  }
  
  // Take the central 50 frames with highest energy
  if (sequence.length <= SEQ_LENGTH) return sequence;
  let bestStart = 0, maxE = -Infinity;
  for (let i = 0; i <= sequence.length - SEQ_LENGTH; i++) {
    let e = 0;
    for (let j = 0; j < SEQ_LENGTH; j++) e += sequence[i + j][14]; // RMS
    if (e > maxE) { maxE = e; bestStart = i; }
  }
  return sequence.slice(bestStart, bestStart + SEQ_LENGTH);
}

// ── Audio Domain Classifier (exact copy from worker) ────────
function computeTemporalVariance(seq, idx) {
  let sum = 0, sumSq = 0;
  for (let i = 0; i < seq.length; i++) { sum += seq[i][idx]; sumSq += seq[i][idx] * seq[i][idx]; }
  const mean = sum / seq.length;
  return (sumSq / seq.length) - (mean * mean);
}

function computeCoeffOfVariation(seq, idx) {
  let sum = 0, sumSq = 0;
  for (let i = 0; i < seq.length; i++) { sum += seq[i][idx]; sumSq += seq[i][idx] * seq[i][idx]; }
  const mean = sum / seq.length;
  const v = (sumSq / seq.length) - (mean * mean);
  const std = Math.sqrt(Math.max(0, v));
  return (Math.abs(mean) > 1e-8) ? (std / Math.abs(mean)) : std;
}

function classifyAudioDomain(seq) {
  let mfccVarSum = 0;
  for (let c = 1; c < N_MFCC; c++) mfccVarSum += computeTemporalVariance(seq, c);
  const avgMfccVar = mfccVarSum / (N_MFCC - 1);
  const rmsCV = computeCoeffOfVariation(seq, 14);
  const zcrVar = computeTemporalVariance(seq, 16);
  const centroidVar = computeTemporalVariance(seq, 17);
  const flatnessVar = computeTemporalVariance(seq, 15);
  
  let silentFrames = 0;
  for (let i = 0; i < seq.length; i++) if (seq[i][14] < 0.005) silentFrames++;
  const silenceRatio = silentFrames / seq.length;
  
  const mfccScore = Math.min(1.0, avgMfccVar / 30.0);
  const rmsScore = Math.min(1.0, rmsCV / 0.8);
  const zcrScore = Math.min(1.0, zcrVar / 0.01);
  const centroidScore = Math.min(1.0, centroidVar / 0.01);
  const flatnessScore = Math.min(1.0, flatnessVar / 0.01);
  const pauseScore = Math.min(1.0, silenceRatio / 0.3);
  
  const humanAudioScore = 0.30 * mfccScore + 0.25 * rmsScore + 0.15 * zcrScore + 0.10 * centroidScore + 0.10 * flatnessScore + 0.10 * pauseScore;
  
  return { humanAudioScore, mfccScore, rmsScore, zcrScore, centroidScore, flatnessScore, pauseScore,
    debug: { avgMfccVar, rmsCV, zcrVar, centroidVar, flatnessVar, silenceRatio } };
}

// ── DTW (exact copy from worker) ────────────────────────────
function euclideanDistance(a, b) {
  let sum = 0;
  const dims = Math.min(a.length, b.length, 14);
  for (let i = 0; i < dims; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

function computeDTW(seqA, seqB) {
  const n = seqA.length, m = seqB.length;
  if (n === 0 || m === 0) return Infinity;
  const dtw = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  dtw[0][0] = 0;
  const window = Math.max(Math.abs(n - m), Math.floor(Math.max(n, m) * 0.2));
  for (let i = 1; i <= n; i++) {
    const start = Math.max(1, i - window);
    const end = Math.min(m, i + window);
    for (let j = start; j <= end; j++) {
      const cost = euclideanDistance(seqA[i-1], seqB[j-1]);
      dtw[i][j] = cost + Math.min(dtw[i-1][j], dtw[i][j-1], dtw[i-1][j-1]);
    }
  }
  return dtw[n][m] / (n + m);
}

function standardizeSequence(seq, dims) {
  const numFrames = seq.length;
  const stdSeq = Array.from({length: numFrames}, () => new Array(seq[0].length));
  for (let d = 0; d < dims; d++) {
    let sum = 0, sumSq = 0;
    for (let f = 0; f < numFrames; f++) { sum += seq[f][d]; sumSq += seq[f][d] * seq[f][d]; }
    const mean = sum / numFrames;
    const std = Math.sqrt(Math.max(0, (sumSq / numFrames) - mean * mean)) || 1;
    for (let f = 0; f < numFrames; f++) stdSeq[f][d] = (seq[f][d] - mean) / std;
  }
  for (let f = 0; f < numFrames; f++) for (let d = dims; d < seq[f].length; d++) stdSeq[f][d] = seq[f][d];
  return stdSeq;
}

// ── Synthetic test signals ──────────────────────────────────
function generateSilence() { return new Float32Array(TARGET_SR); } // 1 second

function generateWhiteNoise(amplitude = 0.01) {
  const buf = new Float32Array(TARGET_SR);
  for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 2 - 1) * amplitude;
  return buf;
}

function generateSpeechLike() {
  // Simulate speech: 200Hz fundamental, amplitude modulated at 4Hz (syllable rate)
  const buf = new Float32Array(TARGET_SR);
  const f0 = 200; // Male F0
  const modRate = 4; // Syllable rate
  for (let i = 0; i < buf.length; i++) {
    const t = i / TARGET_SR;
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * modRate * t);
    // Harmonic series (simulates vocal tract)
    let sample = 0;
    sample += Math.sin(2 * Math.PI * f0 * t) * 0.5;
    sample += Math.sin(2 * Math.PI * f0 * 2 * t) * 0.3;
    sample += Math.sin(2 * Math.PI * f0 * 3 * t) * 0.15;
    sample += Math.sin(2 * Math.PI * f0 * 5 * t) * 0.05;
    buf[i] = sample * envelope * 0.3;
  }
  return buf;
}

function generateEngineLike() {
  // Simulate engine: 30Hz fundamental (1800 RPM), continuous, stationary
  const buf = new Float32Array(TARGET_SR);
  const f0 = 30; // 1800 RPM
  for (let i = 0; i < buf.length; i++) {
    const t = i / TARGET_SR;
    let sample = 0;
    // Many harmonics (engine is broadband)
    for (let h = 1; h <= 20; h++) {
      sample += Math.sin(2 * Math.PI * f0 * h * t) / h;
    }
    // Add some noise
    sample += (Math.random() * 2 - 1) * 0.05;
    buf[i] = sample * 0.15;
  }
  return buf;
}

// ── Main validation ─────────────────────────────────────────
async function runValidation() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' BMAD MEASURE: V8 Pipeline Validation');
  console.log('═══════════════════════════════════════════════════════\n');
  
  const maxDtwDistance = 1.35;
  const references = DTW_FINGERPRINTS;
  
  // Test cases
  const testCases = [];
  
  // 1. Synthetic signals
  testCases.push({ name: '🔇 SILENCE', pcm: generateSilence(), expectedResult: 'reject' });
  testCases.push({ name: '📻 WHITE NOISE (low)', pcm: generateWhiteNoise(0.01), expectedResult: 'reject' });
  testCases.push({ name: '📻 WHITE NOISE (medium)', pcm: generateWhiteNoise(0.05), expectedResult: 'reject' });
  testCases.push({ name: '🗣️ SPEECH-LIKE (AM 4Hz)', pcm: generateSpeechLike(), expectedResult: 'reject' });
  testCases.push({ name: '🔧 ENGINE-LIKE (stationary)', pcm: generateEngineLike(), expectedResult: 'detect' });
  
  // 2. Real Supabase anomaly files  
  const { data: files } = await supabase.storage.from(BUCKET).list('', { limit: 500 });
  const wavFiles = files.filter(f => f.name.toLowerCase().endsWith('.wav') && !f.name.toLowerCase().includes('issue_with'));
  
  for (const file of wavFiles) {
    const { data: wavData } = await supabase.storage.from(BUCKET).download(file.name);
    if (!wavData) continue;
    const buf = Buffer.from(await wavData.arrayBuffer());
    try {
      const parsed = parseWav(buf);
      const pcm16k = parsed.sampleRate === TARGET_SR ? parsed.samples : linearResample(parsed.samples, parsed.sampleRate, TARGET_SR);
      testCases.push({ name: `🎵 ${file.name}`, pcm: pcm16k, expectedResult: 'detect' });
    } catch (e) {
      console.log(`  ❌ Failed to parse ${file.name}: ${e.message}`);
    }
  }
  
  console.log(`Running ${testCases.length} test cases against ${references.length} references...\n`);
  
  // Run each test case
  for (const tc of testCases) {
    const seq = extractFeatureSequence(tc.pcm);
    if (seq.length < 10) {
      console.log(`${tc.name}: SKIP (too short: ${seq.length} frames)`);
      continue;
    }
    
    // Compute gating features
    let maxRMS = 0, sumFlatness = 0, maxFlux = 0;
    for (let i = 0; i < seq.length; i++) {
      if (seq[i][14] > maxRMS) maxRMS = seq[i][14];
      if (seq[i][13] > maxFlux) maxFlux = seq[i][13];
      sumFlatness += seq[i][15];
    }
    const avgFlatness = sumFlatness / seq.length;
    
    // Domain classifier
    const domain = classifyAudioDomain(seq);
    
    // DTW matching
    const liveStd = standardizeSequence(seq, 14);
    const results = [];
    for (const ref of references) {
      if (!ref.dtw_sequence || ref.dtw_sequence.length === 0) continue;
      const dist = computeDTW(liveStd, ref.dtw_sequence);
      results.push({ label: ref.label, fault_type: ref.fault_type, dist });
    }
    results.sort((a, b) => a.dist - b.dist);
    
    const best = results[0];
    const second = results[1];
    const margin = second ? second.dist - best.dist : Infinity;
    
    // Determine what the pipeline would do (matching new V15 worker logic)
    let verdict = 'DETECT';
    let rejectReason = '';
    
    // Hard gates
    if (maxRMS < 0.005) { verdict = 'REJECT'; rejectReason = 'silence'; }
    else if (avgFlatness > 0.90) { verdict = 'REJECT'; rejectReason = `pure_white_noise_flatness=${avgFlatness.toFixed(3)}`; }
    else if (maxFlux < 0.05) { verdict = 'REJECT'; rejectReason = `non_mechanical_flux=${maxFlux.toFixed(3)}`; }
    else if (best.dist > maxDtwDistance) { verdict = 'REJECT'; rejectReason = `no_dtw_alignment_dist=${best.dist.toFixed(3)}`; }
    else if (margin < 0.15) { verdict = 'REJECT'; rejectReason = `ambiguous_margin=${margin.toFixed(3)}`; }
    
    // Composite Confidence Calculation (Stage 8)
    if (verdict === 'DETECT') {
      const dtwScore = Math.max(0.0, 1.0 - (best.dist / maxDtwDistance));
      const relativeMargin = best.dist > 0.001 ? margin / best.dist : margin * 10;
      const marginBonus = Math.min(1.0, relativeMargin / 5.0);
      const domainPenalty = Math.max(0.3, 1.0 - domain.humanAudioScore);
      
      const finalConfidence = dtwScore * marginBonus * domainPenalty;
      
      if (finalConfidence < 0.10) {
        verdict = 'REJECT';
        rejectReason = `low_composite_confidence=${finalConfidence.toFixed(3)}`;
      }
    }
    
    const correct = (verdict === 'REJECT' && tc.expectedResult === 'reject') || 
                    (verdict === 'DETECT' && tc.expectedResult === 'detect');
    const icon = correct ? '✅' : '❌';
    
    console.log(`${icon} ${tc.name}`);
    console.log(`   Frames=${seq.length} maxRMS=${maxRMS.toFixed(4)} avgFlat=${avgFlatness.toFixed(3)} maxFlux=${maxFlux.toFixed(3)}`);
    console.log(`   Domain: humanScore=${domain.humanAudioScore.toFixed(3)} [mfcc=${domain.mfccScore.toFixed(2)} rms=${domain.rmsScore.toFixed(2)} zcr=${domain.zcrScore.toFixed(2)} cent=${domain.centroidScore.toFixed(2)} flat=${domain.flatnessScore.toFixed(2)} pause=${domain.pauseScore.toFixed(2)}]`);
    console.log(`   Raw: mfccVar=${domain.debug.avgMfccVar.toFixed(2)} rmsCV=${domain.debug.rmsCV.toFixed(3)} zcrVar=${domain.debug.zcrVar.toFixed(5)} centVar=${domain.debug.centroidVar.toFixed(5)} flatVar=${domain.debug.flatnessVar.toFixed(5)}`);
    console.log(`   DTW: best="${best.label}" dist=${best.dist.toFixed(3)} | 2nd="${second?.label}" dist=${second?.dist.toFixed(3)} | margin=${margin.toFixed(3)}`);
    console.log(`   Verdict: ${verdict} ${rejectReason ? `(${rejectReason})` : `→ ${best.label}`} | Expected: ${tc.expectedResult}`);
    console.log('');
  }
}

runValidation().catch(console.error);
