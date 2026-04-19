/**
 * audio-processor.worklet.js — Vroomie AudioWorklet Processor
 *
 * Runs in the dedicated AudioWorklet thread (NOT the main JS thread).
 * Responsibility: capture raw PCM from microphone, accumulate into a
 * circular ring buffer, and post a Float32Array snapshot to the main
 * thread every DISPATCH_INTERVAL_FRAMES audio frames.
 *
 * NO feature extraction here — that runs in the Web Worker.
 */

const SAMPLE_RATE_ESTIMATE = 44100; // overridden via options if available
const WINDOW_SECONDS   = 2;         // 2-second sliding window
const DISPATCH_MS      = 500;       // post every 500ms of audio

class VroomieProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const sr = (options && options.processorOptions && options.processorOptions.sampleRate)
      ? options.processorOptions.sampleRate
      : SAMPLE_RATE_ESTIMATE;

    this._sampleRate = sr;
    this._windowSize = Math.ceil(sr * WINDOW_SECONDS);   // e.g. 88200 @ 44.1kHz
    this._dispatchEvery = Math.ceil(sr * DISPATCH_MS / 1000); // samples between dispatches

    // Circular ring buffer — pre-allocated, zero-GC after warmup
    this._ring = new Float32Array(this._windowSize);
    this._writeHead = 0;      // next write position (never wraps — mod on read)
    this._totalSamples = 0;   // total samples written (saturates at Number.MAX_SAFE_INT)
    this._sinceDispatch = 0;  // samples since last dispatch

    this._running = true;

    // Listen for stop signal from main thread
    this.port.onmessage = (ev) => {
      if (ev.data === 'stop') {
        this._running = false;
      }
    };
  }

  process(inputs /*, outputs, parameters */) {
    if (!this._running) return false; // returning false removes the processor

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Mix all channels to mono
    const numChannels = input.length;
    const blockSize   = input[0].length; // typically 128 samples

    for (let i = 0; i < blockSize; i++) {
      let sample = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sample += input[ch][i];
      }
      sample /= numChannels;

      // Write into ring buffer (circular, overwrites oldest data)
      this._ring[this._writeHead % this._windowSize] = sample;
      this._writeHead++;
    }

    this._totalSamples += blockSize;
    this._sinceDispatch += blockSize;

    // Only dispatch when we have at least one full 500ms window
    if (this._sinceDispatch >= this._dispatchEvery && this._totalSamples >= this._windowSize) {
      this._sinceDispatch = 0;

      // Read the most recent _windowSize samples out of the circular buffer in order
      const snapshot = new Float32Array(this._windowSize);
      const start = this._writeHead; // oldest sample position
      for (let i = 0; i < this._windowSize; i++) {
        snapshot[i] = this._ring[(start + i) % this._windowSize];
      }

      // Transfer ownership — zero-copy, no GC
      this.port.postMessage(
        { type: 'pcm', buffer: snapshot, sampleRate: this._sampleRate },
        [snapshot.buffer]
      );
    }

    return true; // keep processor alive
  }
}

registerProcessor('vroomie-processor', VroomieProcessor);
