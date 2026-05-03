/**
 * offline_embedding_test.mjs — Vroomie Pipeline Validation (Node.js, no browser)
 *
 * Downloads all WAV files from the anomaly-patterns bucket,
 * computes 145-dim composite embeddings (same as featureWorker.js),
 * then measures cross-file and self cosine similarities.
 *
 * This reveals whether embeddings are discriminative enough for 0.80 threshold.
 *
 * Usage: node offline_embedding_test.mjs
 */

// ─── Inline audioMath_v11 (browser APIs replaced with Node equivalents) ────────
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
  let totalZCR = 0, totalRMS = 0, totalCentroid = 0;
  const reFFT = new Float32Array(N_FFT), imFFT = new Float32Array(N_FFT);
  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP;
    for (let i = 0; i < N_FFT; i++) { reFFT[i] = (samples[start + i] || 0) * hann[i]; imFFT[i] = 0; }
    fftInPlace(reFFT, imFFT);
    let frameRMS = 0, weightedSum = 0, powerSum = 0;
    for (let k = 0; k < fftBins; k++) {
      const mag = Math.sqrt(reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k]);
      frameRMS += reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k];
      weightedSum += k * mag; powerSum += mag;
      for (let m = 0; m < N_MELS; m++) melHistory[m][f] += fb[m][k] * mag;
    }
    totalRMS += Math.sqrt(frameRMS / fftBins);
    totalCentroid += powerSum > 0 ? (weightedSum / powerSum) / fftBins : 0;
    let zcr = 0;
    for (let i = 1; i < N_FFT; i++) if ((samples[start + i] >= 0) !== (samples[start + i - 1] >= 0)) zcr++;
    totalZCR += zcr / N_FFT;
  }
  const melMean = new Float64Array(N_MELS), melSD = new Float64Array(N_MELS);
  let sumNorm = 0, sumLogNorm = 0;
  for (let m = 0; m < N_MELS; m++) {
    const history = melHistory[m]; let sum = 0, sumSq = 0;
    for (let f = 0; f < numFrames; f++) { sum += history[f]; sumSq += history[f] * history[f]; }
    const mean = sum / numFrames, sd = Math.sqrt(Math.max(0, (sumSq / numFrames) - mean * mean));
    melMean[m] = Math.log(Math.max(mean / bw[m], 1e-10));
    melSD[m] = Math.log(Math.max(sd / bw[m], 1e-10));
    const normE = Math.max(mean / bw[m], 1e-10); sumNorm += normE; sumLogNorm += Math.log(normE);
  }
  const SF = sumNorm / N_MELS > 0 ? Math.exp(sumLogNorm / N_MELS) / (sumNorm / N_MELS) : 0;
  let mSum = 0, mVar = 0;
  for (let m = 0; m < N_MELS; m++) mSum += melMean[m];
  const mAvg = mSum / N_MELS;
  for (let m = 0; m < N_MELS; m++) { melMean[m] -= mAvg; mVar += melMean[m] * melMean[m]; }
  const mStd = Math.max(Math.sqrt(mVar / N_MELS), 1.2);
  for (let m = 0; m < N_MELS; m++) melMean[m] /= mStd;
  let sSum = 0, sVar = 0;
  for (let m = 0; m < N_MELS; m++) sSum += melSD[m];
  const sAvg = sSum / N_MELS;
  for (let m = 0; m < N_MELS; m++) { melSD[m] -= sAvg; sVar += melSD[m] * melSD[m]; }
  const sStd = Math.max(Math.sqrt(sVar / N_MELS), 1.2);
  for (let m = 0; m < N_MELS; m++) melSD[m] /= sStd;
  const mfcc = new Float32Array(N_MFCC);
  for (let k = 0; k < N_MFCC; k++) {
    let sum = 0;
    for (let m = 0; m < N_MELS; m++) sum += melMean[m] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
    mfcc[k] = sum;
  }
  const normMean = l2Norm(melMean), normSD = l2Norm(melSD), normMfcc = l2Norm(mfcc);
  const raw = new Float32Array(N_MELS * 2 + N_MFCC + 1 + 3);
  raw.set(normMean, 0); raw.set(normSD, N_MELS); raw.set(normMfcc, N_MELS * 2);
  raw[N_MELS * 2 + N_MFCC] = SF;
  raw[N_MELS * 2 + N_MFCC + 1] = Math.min(1.0, (totalRMS / numFrames) * 1.5);
  raw[N_MELS * 2 + N_MFCC + 2] = Math.min(1.0, (totalZCR / numFrames) * 2.0);
  raw[N_MELS * 2 + N_MFCC + 3] = Math.min(1.0, (totalCentroid / numFrames) * 1.2);
  return l2Norm(raw);
}

// ─── Preprocessing (same as featureWorker.js) ────────────────────────────────
function linearResample(signal, oldSr, newSr) {
  if (oldSr === newSr) return signal;
  const ratio = oldSr / newSr, newLen = Math.floor(signal.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio, l = Math.floor(idx), r = Math.min(l + 1, signal.length - 1);
    out[i] = signal[l] * (1 - (idx - l)) + signal[r] * (idx - l);
  }
  return out;
}

function biquad(sig, b0, b1, b2, a1, a2) {
  const out = new Float32Array(sig.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const x0 = sig[i], y0 = b0*x0 + b1*x1 + b2*x2 - a1*y1 - a2*y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function applyBandpass(s, sr) {
  const wH = 2*Math.PI*50/sr, cH = Math.cos(wH), sH = Math.sin(wH)/1.414, a0H = 1+sH;
  s = biquad(s, (1+cH)/2/a0H, -(1+cH)/a0H, (1+cH)/2/a0H, -2*cH/a0H, (1-sH)/a0H);
  const wL = 2*Math.PI*5000/sr, cL = Math.cos(wL), sL = Math.sin(wL)/1.414, a0L = 1+sL;
  return biquad(s, (1-cL)/2/a0L, (1-cL)/a0L, (1-cL)/2/a0L, -2*cL/a0L, (1-sL)/a0L);
}

function spectralGate(signal, t) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.abs(signal[i]) > t ? signal[i] : signal[i]*0.1;
  return out;
}

function rmsNorm(signal, target) {
  let sq = 0; for (let i = 0; i < signal.length; i++) sq += signal[i]*signal[i];
  const rms = Math.sqrt(sq/signal.length); if (rms < 1e-8) return signal;
  const gain = target/rms; const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-1, Math.min(1, signal[i]*gain));
  return out;
}

function preprocess(samples, nativeSR) {
  let p = linearResample(samples, nativeSR, TARGET_SR);
  p = applyBandpass(p, TARGET_SR);
  p = spectralGate(p, 0.015);
  p = rmsNorm(p, 0.1);
  return p;
}

// ─── WAV decoder (PCM only, no deps needed) ──────────────────────────────────
function decodeWav(buf) {
  const dv = new DataView(buf);
  const sampleRate = dv.getUint32(24, true);
  const bitsPerSample = dv.getUint16(34, true);
  const numChannels = dv.getUint16(22, true);
  // Find data chunk
  let dataOffset = 44;
  for (let i = 12; i < buf.byteLength - 8; i++) {
    if (dv.getUint8(i) === 0x64 && dv.getUint8(i+1) === 0x61 &&
        dv.getUint8(i+2) === 0x74 && dv.getUint8(i+3) === 0x61) {
      dataOffset = i + 8; break;
    }
  }
  const numSamples = Math.floor((buf.byteLength - dataOffset) / (bitsPerSample / 8) / numChannels);
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    let val = 0;
    const off = dataOffset + i * numChannels * (bitsPerSample / 8);
    if (bitsPerSample === 16) val = dv.getInt16(off, true) / 32768;
    else if (bitsPerSample === 32) val = dv.getFloat32(off, true);
    else if (bitsPerSample === 8) val = (dv.getUint8(off) - 128) / 128;
    samples[i] = val;
  }
  return { samples, sampleRate, numChannels };
}

// ─── Cosine similarity ────────────────────────────────────────────────────────
function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < len; i++) { dot += a[i]*b[i]; nA += a[i]*a[i]; nB += b[i]*b[i]; }
  return (nA > 0 && nB > 0) ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const FILES = [
  'alternator_bearing_fault_critical.wav',
  'BearingAlternator.wav',
  'engine_knocking_high.wav',
  'exhaust_resonance_low.wav',
  'intake_leak_low.wav',
  'misfire_detected_medium.wav',
  'MotorStarter.wav',
  'Piston.wav',
  'PowerSteeringPump.wav',
  'pulley_misalignment_medium.wav',
  'RockerArmAndValve.wav',
  'SerpentineBelt.wav',
  'timing_chain_rattle_high.wav',
  'water_pump_failure_critical.wav',
];

const BASE_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';

async function fetchAudio(filename) {
  const res = await fetch(BASE_URL + encodeURIComponent(filename));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${filename}`);
  const arrayBuf = await res.arrayBuffer();
  return arrayBuf;
}

async function main() {
  console.log('=== VROOMIE EMBEDDING PIPELINE VALIDATION ===\n');
  console.log(`Computing ${FILES.length} embeddings from bucket...`);

  const embeddings = [];
  for (const fname of FILES) {
    try {
      const buf = await fetchAudio(fname);
      const { samples, sampleRate, numChannels } = decodeWav(buf);
      // Mix to mono
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
      // Take first 5 seconds at native SR
      const maxSamples = sampleRate * 5;
      const clipped = mono.slice(0, maxSamples);
      const processed = preprocess(clipped, sampleRate);
      // Check RMS
      let sq = 0; for (let i = 0; i < processed.length; i++) sq += processed[i]*processed[i];
      const rms = Math.sqrt(sq / processed.length);
      const emb = computeCompositeEmbedding(processed, TARGET_SR);
      embeddings.push({ fname, emb, rms, sampleRate });
      console.log(`  ✅ ${fname.padEnd(45)} SR=${sampleRate} RMS=${rms.toFixed(4)} dims=${emb.length}`);
    } catch (err) {
      console.log(`  ❌ ${fname}: ${err.message}`);
    }
  }

  console.log(`\n=== SELF-SIMILARITY (should be ~1.00) ===`);
  for (const { fname, emb } of embeddings) {
    const s = cosine(emb, emb);
    console.log(`  ${fname.padEnd(45)} self=${s.toFixed(4)}`);
  }

  console.log(`\n=== CROSS-SIMILARITY MATRIX (pairwise cosine) ===`);
  console.log('(Higher = more similar. Want: same-class > 0.80, different-class < 0.80)\n');

  // Print condensed header
  const names = embeddings.map(e => e.fname.replace(/\.wav$/i,'').substring(0,20));
  
  let maxCross = 0, minCross = 1, sumCross = 0, countCross = 0;
  const matrix = [];
  for (let i = 0; i < embeddings.length; i++) {
    const row = [];
    for (let j = 0; j < embeddings.length; j++) {
      const s = i === j ? 1.0 : cosine(embeddings[i].emb, embeddings[j].emb);
      row.push(s);
      if (i !== j) { maxCross = Math.max(maxCross, s); minCross = Math.min(minCross, s); sumCross += s; countCross++; }
    }
    matrix.push(row);
  }

  // Print condensed cross-matrix
  for (let i = 0; i < embeddings.length; i++) {
    const rowStr = matrix[i].map((v, j) => {
      if (i === j) return '  --  ';
      const mark = v >= 0.80 ? '⚠' : ' ';
      return `${mark}${v.toFixed(3)}`;
    }).join(' ');
    console.log(`  ${names[i].padEnd(22)} ${rowStr}`);
  }

  const avgCross = sumCross / countCross;
  console.log(`\n  Max cross-similarity: ${maxCross.toFixed(4)}`);
  console.log(`  Min cross-similarity: ${minCross.toFixed(4)}`);
  console.log(`  Avg cross-similarity: ${avgCross.toFixed(4)}`);

  // Check false positive risk: any cross-pair >= 0.80?
  const falsePosRisk = [];
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i+1; j < embeddings.length; j++) {
      const s = matrix[i][j];
      if (s >= 0.80) falsePosRisk.push(`${names[i]} vs ${names[j]}: ${s.toFixed(4)}`);
    }
  }
  if (falsePosRisk.length > 0) {
    console.log(`\n⚠️  FALSE POSITIVE RISK (cross-pair >= 0.80):`);
    falsePosRisk.forEach(x => console.log('   ' + x));
    console.log(`\n   → THRESHOLD needs to be RAISED or features need improvement`);
  } else {
    console.log(`\n✅ No cross-pairs >= 0.80 — threshold 0.80 is safe for these files`);
  }

  // Simulate a live clip: use first 2 seconds of each file as "live" and match against all refs
  console.log(`\n=== SIMULATED LIVE MATCHING (2s window from each file) ===`);
  console.log(`(Tests: does each 2s clip correctly match its own full-file reference?)\n`);
  
  let passed = 0, failed = 0;
  for (const { fname, sampleRate } of embeddings) {
    try {
      const buf = await fetchAudio(fname);
      const { samples, numChannels } = decodeWav(buf);
      let mono;
      if (numChannels === 1) { mono = samples; }
      else {
        mono = new Float32Array(Math.floor(samples.length / numChannels));
        for (let i = 0; i < mono.length; i++) {
          let s = 0; for (let c = 0; c < numChannels; c++) s += samples[i*numChannels+c]; mono[i] = s/numChannels;
        }
      }
      // 2-second live clip (same as AudioWorklet window)
      const liveLen = sampleRate * 2;
      const liveClip = mono.slice(0, liveLen);
      const liveProc = preprocess(liveClip, sampleRate);
      const liveEmb = computeCompositeEmbedding(liveProc, TARGET_SR);
      
      // Match against all refs
      let bestScore = 0, bestName = 'none';
      for (const ref of embeddings) {
        const s = cosine(liveEmb, ref.emb);
        if (s > bestScore) { bestScore = s; bestName = ref.fname; }
      }

      const selfScore = cosine(liveEmb, embeddings.find(e=>e.fname===fname).emb);
      const isMatch = bestName === fname;
      const accepted = selfScore >= 0.80;
      const result = accepted && isMatch ? '✅ PASS' : (accepted && !isMatch ? '⚠ WRONG LABEL' : '❌ FAIL (< threshold)');
      
      if (accepted && isMatch) passed++;
      else failed++;
      
      console.log(`  ${result} ${fname.padEnd(45)} selfSim=${selfScore.toFixed(3)} bestSim=${bestScore.toFixed(3)} matched=${bestName.substring(0,25)}`);
    } catch (err) {
      console.log(`  ❌ ${fname}: ${err.message}`);
      failed++;
    }
  }
  
  const total = passed + failed;
  const accuracy = total > 0 ? (passed / total * 100).toFixed(1) : 0;
  console.log(`\n=== RESULT: ${passed}/${total} passed = ${accuracy}% accuracy ===`);
  if (accuracy >= 95) console.log('✅ MEETS 95% TARGET');
  else console.log('❌ BELOW 95% TARGET — pipeline needs tuning');
}

main().catch(console.error);
