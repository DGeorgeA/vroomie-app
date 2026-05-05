/**
 * DSP_Regression.test.js
 * 
 * Automated Regression Test Suite for Vroomie.in Audio Pipeline (v5 Hardened)
 * Proves mathematical certainty of the DSP algorithms under various noise floors.
 */

const fs = require('fs');
const path = require('path');

// ─── 1. MOCK WORKER ENVIRONMENT ───────────────────────────────────────────────
// We evaluate the worker code in this context to test its pure math logic.
const workerScript = fs.readFileSync(path.join(__dirname, 'AudioV5_SuperProcessor.worker.js'), 'utf8');

const selfMock = {
  postMessage: jest.fn(),
  onmessage: null
};

// Create a functional context for the worker
const workerEnv = new Function('self', `
  ${workerScript}
  return {
    onmessage: self.onmessage,
    calculateDynamicThreshold,
    computeFFT,
    applyHanning,
    computePAPR,
    computeSpectralFlatness
  };
`);

const workerFunctions = workerEnv(selfMock);

// ─── 2. SIGNAL SYNTHESIS UTILITIES ────────────────────────────────────────────
const TARGET_SR = 44100;

function generateWhiteNoise(length, levelDb) {
  const signal = new Float32Array(length);
  const amp = Math.pow(10, levelDb / 20);
  for (let i = 0; i < length; i++) {
    signal[i] = (Math.random() * 2 - 1) * amp;
  }
  return signal;
}

function generatePinkNoise(length, levelDb) {
  const signal = new Float32Array(length);
  const amp = Math.pow(10, levelDb / 20);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    signal[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * amp * 0.11;
    b6 = white * 0.115926;
  }
  return signal;
}

function generateSine(length, freq, amp) {
  const signal = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    signal[i] = Math.sin(2 * Math.PI * freq * i / TARGET_SR) * amp;
  }
  return signal;
}

function generateBandpassNoise(length, freqLow, freqHigh, amp) {
  // Simple approximation: sum of sines in the band
  const signal = new Float32Array(length);
  const steps = 50;
  const stepSize = (freqHigh - freqLow) / steps;
  for (let s = 0; s < steps; s++) {
    const freq = freqLow + s * stepSize;
    const phase = Math.random() * Math.PI * 2;
    for (let i = 0; i < length; i++) {
      signal[i] += Math.sin(2 * Math.PI * freq * i / TARGET_SR + phase) * (amp / steps);
    }
  }
  return signal;
}

function injectTransients(signal, rateHz, amp) {
  const samplesPerSpike = Math.floor(TARGET_SR / rateHz);
  for (let i = 0; i < signal.length; i += samplesPerSpike) {
    // 5-sample spike
    for(let j=0; j<5 && i+j < signal.length; j++){
       signal[i+j] += amp;
    }
  }
  return signal;
}

function combineSignals(...signals) {
  const length = signals[0].length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const sig of signals) sum += sig[i];
    out[i] = sum;
  }
  return out;
}

// ─── 3. TEST SUITE ────────────────────────────────────────────────────────────
describe('Vroomie DSP Hardened Algorithm (v5)', () => {
  let mockReferenceIndex;

  beforeEach(() => {
    selfMock.postMessage.mockClear();
    
    // Create ideal reference fingerprints for our mock Supabase references
    // Alternator: 5kHz Sine + White Noise
    // It's broadband with a sharp peak at 5kHz (index 92).
    const altVec = new Array(743).fill(0.5); // white noise baseline
    altVec[92] = 2.0; // 5kHz spike

    // Intake Leak: Flatness in 8k-12k (Pink Noise + 8k-12k bandpass).
    // Pink noise is higher at low frequencies. Bandpass is flat at high frequencies.
    // So 4k-8k has falling pink noise, 8k-12k has flat bandpass noise.
    const intakeVec = new Array(743).fill(0);
    for(let i=0; i<372; i++) intakeVec[i] = 0.3 * (1 - i/372); // simulate pink noise falloff
    for(let i=372; i<743; i++) intakeVec[i] = 0.8; // bandpass 8k-12k

    mockReferenceIndex = [
      { id: 'ref1', label: 'alternator_bearing_fault_critical', fault_type: 'alternator_bearing_fault', cosine_vec: altVec },
      { id: 'ref2', label: 'intake_leak_low', fault_type: 'intake_leak', cosine_vec: intakeVec }
    ];

    workerFunctions.onmessage({ data: { type: 'setReferenceIndex', payload: mockReferenceIndex } });
  });

  test('Adaptive Noise Floor Tracking (Math Integrity)', () => {
    // Test that quiet room yields 0.82 and loud yields 0.90
    const quietProfile = new Float32Array(2048).fill(0.005);
    const quietThresh = workerFunctions.calculateDynamicThreshold(quietProfile);
    expect(quietThresh).toBeCloseTo(0.82);

    const loudProfile = new Float32Array(2048).fill(0.15);
    const loudThresh = workerFunctions.calculateDynamicThreshold(loudProfile);
    expect(loudThresh).toBeCloseTo(0.90);
  });

  test('Test 1 (The Whine): 5kHz Sine + Amplitude Spikes + -10dB White Noise', () => {
    // 3 seconds of audio
    const length = TARGET_SR * 3;
    const noise = generateWhiteNoise(length, -10);
    const sine = generateSine(length, 5000, 0.5);
    let signal = combineSignals(noise, sine);
    signal = injectTransients(signal, 15, 1.0); // 15 Hz knocking/spikes

    // Send in 500ms chunks to mimic audioFeatureExtractor
    const chunkSize = TARGET_SR * 0.5;
    for(let offset=0; offset < length; offset+=chunkSize) {
      const chunk = signal.slice(offset, offset + chunkSize);
      workerFunctions.onmessage({ data: { type: 'process', payload: { buffer: chunk, sampleRate: TARGET_SR } } });
    }

    workerFunctions.onmessage({ data: { type: 'stop', payload: null } });

    // Assert that the worker posted a match for alternator
    expect(selfMock.postMessage).toHaveBeenCalled();
    const callArg = selfMock.postMessage.mock.calls[0][0];
    expect(callArg.type).toBe('result');
    expect(callArg.payload.status).toBe('anomaly');
    expect(callArg.payload.anomaly).toBe('alternator_bearing_fault_critical');
    // Ensure threshold > 0.82
    expect(callArg.payload.confidence).toBeGreaterThan(0.82);
  });

  test('Test 2 (The Hiss): 8kHz-12kHz Broadband + -5dB Pink Noise', () => {
    const length = TARGET_SR * 3;
    const noise = generatePinkNoise(length, -5);
    const hiss = generateBandpassNoise(length, 8000, 12000, 0.4);
    const signal = combineSignals(noise, hiss);

    const chunkSize = TARGET_SR * 0.5;
    for(let offset=0; offset < length; offset+=chunkSize) {
      const chunk = signal.slice(offset, offset + chunkSize);
      workerFunctions.onmessage({ data: { type: 'process', payload: { buffer: chunk, sampleRate: TARGET_SR } } });
    }

    workerFunctions.onmessage({ data: { type: 'stop', payload: null } });

    expect(selfMock.postMessage).toHaveBeenCalled();
    const callArg = selfMock.postMessage.mock.calls[0][0];
    expect(callArg.type).toBe('result');
    expect(callArg.payload.status).toBe('anomaly');
    expect(callArg.payload.anomaly).toBe('intake_leak_low');
  });

  test('Test 3 (The Control): Low-frequency engine rumble (100Hz-400Hz)', () => {
    const length = TARGET_SR * 3;
    const rumble = generateBandpassNoise(length, 100, 400, 0.9);
    const quietNoise = generateWhiteNoise(length, -30);
    const signal = combineSignals(rumble, quietNoise);

    const chunkSize = TARGET_SR * 0.5;
    for(let offset=0; offset < length; offset+=chunkSize) {
      const chunk = signal.slice(offset, offset + chunkSize);
      workerFunctions.onmessage({ data: { type: 'process', payload: { buffer: chunk, sampleRate: TARGET_SR } } });
    }

    workerFunctions.onmessage({ data: { type: 'stop', payload: null } });

    expect(selfMock.postMessage).toHaveBeenCalled();
    const callArg = selfMock.postMessage.mock.calls[0][0];
    expect(callArg.type).toBe('result');
    expect(callArg.payload.status).toBe('normal'); // NO MATCH
    expect(callArg.payload.anomaly).toBeNull();
  });
});
