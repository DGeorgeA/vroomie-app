/**
 * Mel Spectrogram Generator — Pure Web Audio API/JS implementation.
 * Converts raw audio PCM data → Mel-scaled spectrogram tensor suitable for CNN input.
 * Target output shape: (128, 128, 1)
 */
import { Logger } from './logger';

// ─── Constants ────────────────────────────────────────────
// For 16kHz audio:
// 25ms window = 400 samples (zero-padded to 512 for FFT)
// 10ms hop = 160 samples
const N_FFT = 512;
const WINDOW_SAMPLES = 400; 
const HOP_LENGTH = 160;
const N_MELS = 128;
const TARGET_TIME_FRAMES = 128; // Standard output length
const F_MIN = 0;
const F_MAX_RATIO = 0.5; // Nyquist

// ─── Mel Filterbank ───────────────────────────────────────
function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function createMelFilterbank(sampleRate, nFft, nMels, fMin, fMax) {
  const fftBins = Math.floor(nFft / 2) + 1;
  fMax = fMax || sampleRate / 2;

  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  
  // Linearly spaced mel points
  const melPoints = new Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    melPoints[i] = melMin + (i * (melMax - melMin)) / (nMels + 1);
  }
  
  // Convert back to Hz and then to FFT bin indices
  const binPoints = melPoints.map(mel => {
    const hz = melToHz(mel);
    return Math.floor((nFft + 1) * hz / sampleRate);
  });
  
  // Build triangular filters
  const filterbank = [];
  for (let m = 0; m < nMels; m++) {
    const filter = new Float32Array(fftBins);
    const start = binPoints[m];
    const center = binPoints[m + 1];
    const end = binPoints[m + 2];
    
    for (let k = start; k < center; k++) {
      if (k < fftBins) {
        filter[k] = (center - start) > 0 ? (k - start) / (center - start) : 0;
      }
    }
    for (let k = center; k <= end; k++) {
      if (k < fftBins) {
        filter[k] = (end - center) > 0 ? (end - k) / (end - center) : 0;
      }
    }
    filterbank.push(filter);
  }
  return filterbank;
}

// ─── Hann Window ──────────────────────────────────────────
function hannWindow(length) {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
  }
  return window;
}

// ─── Simple FFT (Radix-2 Cooley-Tukey) ───────────────────
function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;

  // Bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // FFT
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const tRe = curRe * re[i + j + halfLen] - curIm * im[i + j + halfLen];
        const tIm = curRe * im[i + j + halfLen] + curIm * re[i + j + halfLen];
        
        re[i + j + halfLen] = re[i + j] - tRe;
        im[i + j + halfLen] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;

        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

// ─── Power Spectrogram (single frame) ─────────────────────
function computePowerSpectrum(frame, window) {
  const n = frame.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  
  for (let i = 0; i < n; i++) {
    re[i] = frame[i] * window[i];
    im[i] = 0;
  }
  
  fft(re, im);
  
  // Power spectrum (only positive frequencies)
  const fftBins = Math.floor(n / 2) + 1;
  const power = new Float32Array(fftBins);
  for (let i = 0; i < fftBins; i++) {
    power[i] = (re[i] * re[i] + im[i] * im[i]) / n;
  }
  return power;
}

// ─── Power to dB ──────────────────────────────────────────
function powerToDb(spectrogram, refValue = 1.0, amin = 1e-10, topDb = 80) {
  const result = new Float32Array(spectrogram.length);
  const refPower = refValue * refValue;

  for (let i = 0; i < spectrogram.length; i++) {
    result[i] = 10 * Math.log10(Math.max(spectrogram[i], amin) / refPower);
  }

  // Clip to top_db
  let maxVal = -Infinity;
  for (let i = 0; i < result.length; i++) {
    if (result[i] > maxVal) maxVal = result[i];
  }
  for (let i = 0; i < result.length; i++) {
    result[i] = Math.max(result[i], maxVal - topDb);
  }
  return result;
}

// ─── Normalize to [0, 1] ─────────────────────────────────
function normalizeSpectrogram(data) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  const range = max - min || 1;
  const result = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = (data[i] - min) / range;
  }
  return result;
}

// ─── Resize time dimension to TARGET_TIME_FRAMES ──────────
function resizeTimeAxis(melSpec, nMels, originalFrames, targetFrames) {
  const result = new Float32Array(nMels * targetFrames);
  const ratio = originalFrames / targetFrames;
  
  for (let t = 0; t < targetFrames; t++) {
    const srcT = Math.min(Math.floor(t * ratio), originalFrames - 1);
    for (let m = 0; m < nMels; m++) {
      result[m * targetFrames + t] = melSpec[m * originalFrames + srcT];
    }
  }
  return result;
}

// ─── MAIN: Generate Mel Spectrogram from PCM Float32Array ─
/**
 * Generates a mel spectrogram from raw PCM audio data.
 * @param {Float32Array} pcmData - Raw mono audio samples
 * @param {number} sampleRate - Sample rate of the audio
 * @returns {Float32Array} - Flat array of shape (128, 128) normalized to [0,1]
 */
export function generateMelSpectrogram(pcmData, sampleRate) {
  const fMax = sampleRate * F_MAX_RATIO;
  const filterbank = createMelFilterbank(sampleRate, N_FFT, N_MELS, F_MIN, fMax);
  const window = hannWindow(N_FFT);
  
  // Zero-pad if audio is shorter than one FFT frame
  let paddedData = pcmData;
  if (pcmData.length < N_FFT) {
    paddedData = new Float32Array(N_FFT);
    paddedData.set(pcmData);
  }
  
  // Calculate number of frames
  const numFrames = Math.max(1, Math.floor((paddedData.length - WINDOW_SAMPLES) / HOP_LENGTH) + 1);
  
  // Compute mel spectrogram (nMels x numFrames)
  const melSpec = new Float32Array(N_MELS * numFrames);
  
  for (let t = 0; t < numFrames; t++) {
    const start = t * HOP_LENGTH;
    const frame = new Float32Array(N_FFT); // Zero-initialized
    
    // Copy frame data (400 samples, zero-pad remainder of 512 N_FFT)
    const copyLen = Math.min(WINDOW_SAMPLES, paddedData.length - start);
    for (let i = 0; i < copyLen; i++) {
      frame[i] = paddedData[start + i];
    }
    
    const powerSpec = computePowerSpectrum(frame, window);
    
    // Apply mel filterbank
    for (let m = 0; m < N_MELS; m++) {
      let energy = 0;
      for (let k = 0; k < powerSpec.length; k++) {
        energy += filterbank[m][k] * powerSpec[k];
      }
      melSpec[m * numFrames + t] = energy;
    }
  }
  
  // Convert to dB scale
  const melDb = powerToDb(melSpec);
  
  // Resize to target time frames (128)
  const resized = resizeTimeAxis(melDb, N_MELS, numFrames, TARGET_TIME_FRAMES);
  
  // Normalize to [0, 1]
  const normalized = normalizeSpectrogram(resized);
  
  Logger.debug(`Spectrogram generated: ${N_MELS}x${TARGET_TIME_FRAMES} from ${pcmData.length} samples @ ${sampleRate}Hz`);
  
  return normalized;
}

/**
 * Generate spectrogram from an AudioBuffer (decoded audio).
 * @param {AudioBuffer} audioBuffer - Decoded Web Audio buffer
 * @returns {Float32Array} - Flat (128x128) normalized mel spectrogram
 */
export function generateMelSpectrogramFromAudioBuffer(audioBuffer) {
  const pcmData = audioBuffer.getChannelData(0); // Mono channel
  return generateMelSpectrogram(pcmData, audioBuffer.sampleRate);
}

export { N_MELS, TARGET_TIME_FRAMES };
