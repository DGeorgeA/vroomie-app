/**
 * audioMath.js — Shared Signal Processing Utilities
 * 
 * Ensures identical mathematical treatment for both Live (WebWorker) 
 * and Reference (Main Thread) audio feature extraction.
 */

export const TARGET_SR = 16000;
export const N_FFT = 512;
export const HOP = 160;
export const N_MELS = 64;
export const N_MFCC = 13;

// Hann Window Cache
const _hannCache = {};
export function getHannWindow(size) {
  if (_hannCache[size]) return _hannCache[size];
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (size - 1));
  }
  _hannCache[size] = w;
  return w;
}

/**
 * Cooley-Tukey Radix-2 FFT (in-place)
 */
export function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const wAngle = (2 * Math.PI) / len;
    const wRe = Math.cos(wAngle), wIm = Math.sin(wAngle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const tRe = curRe * re[i + j + half] - curIm * im[i + j + half];
        const tIm = curRe * im[i + j + half] + curIm * re[i + j + half];
        re[i + j + half] = re[i + j] - tRe;
        im[i + j + half] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;
        const nCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nCurRe;
      }
    }
  }
}

export const PIPELINE_VERSION = "11.5.STABLE";

let _cachedFB = null;
let _cachedBW = null; // Filter bandwidths
let _cachedFBsr = -1;

export function getMelFilterbank(sr) {
  if (_cachedFB && _cachedFBsr === sr) return { fb: _cachedFB, bw: _cachedBW };
  const fftBins = N_FFT / 2 + 1;
  const melMin = 0;
  const melMax = 2595 * Math.log10(1 + (sr / 2) / 700);
  const melPts = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    melPts[i] = melMin + i * (melMax - melMin) / (N_MELS + 1);
  }
  const hzPts = new Float32Array(N_MELS + 2);
  const binPts = new Int32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    hzPts[i] = 700 * (Math.pow(10, melPts[i] / 2595) - 1);
    binPts[i] = Math.floor((N_FFT + 1) * hzPts[i] / sr);
  }
  const fb = [];
  const bw = new Float32Array(N_MELS);
  for (let m = 0; m < N_MELS; m++) {
    const f = new Float32Array(fftBins);
    const lo = binPts[m], cen = binPts[m + 1], hi = binPts[m + 2];
    bw[m] = Math.max(1, hi - lo); 
    for (let k = lo; k < cen && k < fftBins; k++) {
      f[k] = (cen - lo) > 0 ? (k - lo) / (cen - lo) : 0;
    }
    for (let k = cen; k <= hi && k < fftBins; k++) {
      f[k] = (hi - cen) > 0 ? (hi - k) / (hi - cen) : 0;
    }
    fb.push(f);
  }
  _cachedFB = fb;
  _cachedBW = bw;
  _cachedFBsr = sr;
  return { fb, bw };
}

export function l2Norm(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
  n = Math.sqrt(n) || 1e-10;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
  return out;
}

/**
 * 145-dim Composite Embedding (v11.0 Temporal Dynamics)
 */
export function computeCompositeEmbedding(samples, sr) {
  const { fb, bw } = getMelFilterbank(sr);
  const hann = getHannWindow(N_FFT);
  const fftBins = N_FFT / 2 + 1;
  const numFrames = Math.max(1, Math.floor((samples.length - N_FFT) / HOP));

  // Capture history for variance calculation
  const melHistory = Array.from({ length: N_MELS }, () => new Float64Array(numFrames));
  let totalZCR = 0, totalRMS = 0, totalCentroid = 0;

  const reFFT = new Float32Array(N_FFT);
  const imFFT = new Float32Array(N_FFT);

  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      reFFT[i] = (samples[start + i] || 0) * hann[i];
      imFFT[i] = 0;
    }
    fftInPlace(reFFT, imFFT);
    let frameRMS = 0, weightedSum = 0, powerSum = 0;
    for (let k = 0; k < fftBins; k++) {
      const mag = Math.sqrt(reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k]);
      frameRMS += reFFT[k] * reFFT[k] + imFFT[k] * imFFT[k];
      weightedSum += k * mag;
      powerSum += mag;
      for (let m = 0; m < N_MELS; m++) {
        melHistory[m][f] = fb[m][k] * mag;
      }
    }
    totalRMS += Math.sqrt(frameRMS / fftBins);
    totalCentroid += powerSum > 0 ? (weightedSum / powerSum) / fftBins : 0;
    let zcr = 0;
    for (let i = 1; i < N_FFT; i++) {
      if ((samples[start + i] >= 0) !== (samples[start + i - 1] >= 0)) zcr++;
    }
    totalZCR += zcr / N_FFT;
  }

  const melMean = new Float64Array(N_MELS);
  const melSD   = new Float64Array(N_MELS);
  let sumNormEnergies = 0, sumLogNormEnergies = 0;

  for (let m = 0; m < N_MELS; m++) {
    const history = melHistory[m];
    let sum = 0, sumSq = 0;
    for (let f = 0; f < numFrames; f++) {
      sum += history[f];
      sumSq += history[f] * history[f];
    }
    const mean = sum / numFrames;
    const sd   = Math.sqrt(Math.max(0, (sumSq / numFrames) - (mean * mean)));
    
    melMean[m] = Math.log(Math.max(mean / bw[m], 1e-10));
    melSD[m]   = Math.log(Math.max(sd / bw[m], 1e-10));

    const normEnergy = Math.max(mean / bw[m], 1e-10);
    sumNormEnergies += normEnergy;
    sumLogNormEnergies += Math.log(normEnergy);
  }

  const arithmeticMean = sumNormEnergies / N_MELS;
  const geometricMean = Math.exp(sumLogNormEnergies / N_MELS);
  const spectralFlatness = arithmeticMean > 0 ? (geometricMean / arithmeticMean) : 0;

  // CMVN for Mean
  let mSum = 0, mVar = 0;
  for (let m = 0; m < N_MELS; m++) mSum += melMean[m];
  const mAvg = mSum / N_MELS;
  for (let m = 0; m < N_MELS; m++) {
    melMean[m] -= mAvg;
    mVar += melMean[m] * melMean[m];
  }
  const mStd = Math.max(Math.sqrt(mVar / N_MELS), 1.2);
  for (let m = 0; m < N_MELS; m++) melMean[m] /= mStd;

  // CMVN for SD
  let sSum = 0, sVar = 0;
  for (let m = 0; m < N_MELS; m++) sSum += melSD[m];
  const sAvg = sSum / N_MELS;
  for (let m = 0; m < N_MELS; m++) {
    melSD[m] -= sAvg;
    sVar += melSD[m] * melSD[m];
  }
  const sStd = Math.max(Math.sqrt(sVar / N_MELS), 1.2);
  for (let m = 0; m < N_MELS; m++) melSD[m] /= sStd;

  const avgRMS = totalRMS / numFrames;
  const avgZCR = totalZCR / numFrames;
  const avgCentroid = totalCentroid / numFrames;

  // Calculate MFCC from Mel Mean
  const mfcc = new Float32Array(N_MFCC);
  for (let k = 0; k < N_MFCC; k++) {
    let sum = 0;
    for (let m = 0; m < N_MELS; m++) {
      sum += melMean[m] * Math.cos(Math.PI * k * (m + 0.5) / N_MELS);
    }
    mfcc[k] = sum;
  }

  const normMean = l2Norm(melMean);
  const normSD   = l2Norm(melSD);
  const normMfcc = l2Norm(mfcc);

  // Stack: 64 Mean + 64 SD + 13 MFCC + 1 SF + 3 stats = 145 dims
  const raw = new Float32Array(N_MELS * 2 + N_MFCC + 1 + 3);
  raw.set(normMean, 0);
  raw.set(normSD,   N_MELS);
  raw.set(normMfcc, N_MELS * 2);
  raw[N_MELS * 2 + N_MFCC] = spectralFlatness; // [141]
  raw[N_MELS * 2 + N_MFCC + 1] = Math.min(1.0, avgRMS * 1.5);
  raw[N_MELS * 2 + N_MFCC + 2] = Math.min(1.0, avgZCR * 2.0);
  raw[N_MELS * 2 + N_MFCC + 3] = Math.min(1.0, avgCentroid * 1.2);

  return l2Norm(raw);
}
