import { Logger } from './logger';
import { initializeEmbeddingEngine, getAudioAnalysis, findBestMatch } from './mlEmbeddingEngine';
import { loadConstellationIndex, createRollingMatcher, isIndexReady } from './constellationMatcher';

// ─── Module-level state ───────────────────────────────────
let isExtracting        = false;
let audioContext        = null;
let mediaStreamSource   = null;
let mediaStream         = null;
let scriptProcessor     = null;
let onFeaturesCallback  = null;
// Shazam-style fast path: rolling fingerprint listener. Additive — it never
// suppresses the embedding pipeline, and a missing index simply disables it.
let rollingMatcher      = null;
let constellationFired  = false;
// Best fingerprint evidence seen this session, even when it never cleared
// threshold. Recorded into session_diagnostics so a failed field session
// shows HOW CLOSE the fingerprint got instead of just 'nothing matched'.
let bestFingerprint     = { score: 0, normalized: 0, label: null };
// Audio captured BEFORE the index finished loading. Flushed into the matcher
// the moment it arms, so a slow first fetch no longer costs the opening
// seconds of the session (a measured cause of intermittent detection).
let pendingFeed         = [];
let pendingFeedSamples  = 0;
const PENDING_FEED_CAP  = TARGET_SR * 6;

const TARGET_SR = 16000;
const SCRIPT_BUFFER_SIZE = 4096;

// Linear resampler — device capture rate → YAMNet's required 16 kHz.
function resampleTo16k(pcm, srIn) {
  if (srIn === TARGET_SR) return pcm.length === TARGET_SR ? pcm : pcm.slice(0, TARGET_SR);
  const ratio = srIn / TARGET_SR;
  const out = new Float32Array(TARGET_SR);
  const maxIdx = pcm.length - 1;
  for (let i = 0; i < TARGET_SR; i++) {
    const x = i * ratio;
    const l = Math.min(maxIdx, Math.floor(x));
    const r = Math.min(maxIdx, l + 1);
    out[i] = pcm[l] * (1 - (x - l)) + pcm[r] * (x - l);
  }
  return out;
}

// Variable-length block resampler for the fingerprint feed. resampleTo16k()
// always emits exactly 1 s; the fast path is fed per audio block instead, so it
// needs a proportional-length resample.
function resampleBlockTo16k(block, srIn) {
  if (srIn === TARGET_SR) return block;
  const ratio = srIn / TARGET_SR;
  const outLen = Math.max(1, Math.floor(block.length / ratio));
  const out = new Float32Array(outLen);
  const maxIdx = block.length - 1;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const l = Math.min(maxIdx, Math.floor(x));
    const r = Math.min(maxIdx, l + 1);
    out[i] = block[l] * (1 - (x - l)) + block[r] * (x - l);
  }
  return out;
}

// Identical to the reference factory's loudness normalization — live windows
// and reference embeddings must see the same input level.
function rmsNormalize(pcm, target = 0.05) {
  let sq = 0;
  for (let i = 0; i < pcm.length; i++) sq += pcm[i] * pcm[i];
  const r = Math.sqrt(sq / pcm.length);
  if (r < 1e-6) return pcm;
  const g = target / r;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i] * g));
  return out;
}

// Warm the fingerprint index shortly after this module loads — well before the
// user presses record. Previously the 1.7 MB fetch only began at startExtraction,
// so a cold cache meant the fast path armed several seconds into the session.
if (typeof window !== 'undefined') {
  setTimeout(() => { loadConstellationIndex().catch(() => {}); }, 1200);
}

// ─── Public API ───────────────────────────────────────────

export function getActiveMediaStream()   { return mediaStream; }
export function getActiveAudioContext()  { return audioContext; }

// Actual constraints the DEVICE applied (not what we requested) — some Android
// builds silently ignore noiseSuppression:false, which guts broadband fault
// signatures. Recorded into every report's session_diagnostics.
let appliedCaptureSettings = null;
export function getCaptureSettings() { return appliedCaptureSettings; }
export function getBestFingerprint() { return bestFingerprint; }

export async function startExtraction(callback) {
  if (isExtracting) {
    Logger.warn('Extraction already running.');
    return;
  }

  isExtracting       = true;
  onFeaturesCallback = callback;
  constellationFired = false;
  rollingMatcher     = null;
  bestFingerprint    = { score: 0, normalized: 0, label: null };
  pendingFeed        = [];
  pendingFeedSamples = 0;

  Logger.info('🎤 [START] Requesting microphone and loading YAMNet...');

  try {
    // Eagerly load YAMNet
    await initializeEmbeddingEngine();

    // Fingerprint index loads in parallel and NEVER blocks capture: if it is
    // unavailable the session simply runs on the embedding pipeline alone.
    loadConstellationIndex()
      .then(ok => {
        if (ok && isExtracting) {
          rollingMatcher = createRollingMatcher();
          Logger.info('[Constellation] fingerprint index ready — fast path armed');
        } else if (!ok) {
          Logger.warn('[Constellation] index unavailable — embedding path only');
        }
      })
      .catch(() => { /* fail safe: fast path stays disabled */ });

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    try {
      const track = mediaStream.getAudioTracks()[0];
      const s = track && track.getSettings ? track.getSettings() : {};
      appliedCaptureSettings = {
        sampleRate: s.sampleRate ?? null,
        echoCancellation: s.echoCancellation ?? null,
        noiseSuppression: s.noiseSuppression ?? null,
        autoGainControl: s.autoGainControl ?? null
      };
      Logger.info(`🎚️ Applied capture settings: ${JSON.stringify(appliedCaptureSettings)}`);
      if (appliedCaptureSettings.noiseSuppression === true) {
        Logger.warn('⚠️ Device is FORCING noise suppression — broadband fault signatures may be attenuated on this hardware.');
      }
    } catch (e) {
      appliedCaptureSettings = null;
    }

    // Capture at the DEVICE's native rate and resample to 16 kHz in code.
    // Forcing a 16 kHz context on a mic stream is a known iOS Safari failure
    // class (silence / NotSupportedError when context rate != hardware rate);
    // native-rate capture behaves identically on every platform.
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const sr = audioContext.sampleRate;
    Logger.info(`✅ AudioContext sampleRate=${sr} (resampling to ${TARGET_SR} in software)`);

    mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessor capture — processes 1-second windows for YAMNet classification
    useScriptProcessorMainThreadCapture(sr);

    Logger.info(`🎙️ Recording started (SR=${sr})`);
  } catch (error) {
    Logger.error('Failed to start extraction:', error);
    isExtracting = false;
    throw error;
  }
}

function useScriptProcessorMainThreadCapture(sr) {
  const windowSamples  = sr * 1; // 1-second window (16000 samples at 16kHz)
  const ring       = new Float32Array(windowSamples);
  let writeHead    = 0;
  let totalSamples = 0;
  let isProcessing = false; // Prevent overlapping async YAMNet calls
  let lastClassifyTime = 0; // Timestamp of last classification attempt
  let lastFingerprintTry = 0; // fingerprint cadence, independent of YAMNet

  scriptProcessor = audioContext.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
  
  scriptProcessor.onaudioprocess = async (e) => {
    if (!isExtracting) return;

    const input = e.inputBuffer;
    const numCh = input.numberOfChannels;
    const ch0   = input.getChannelData(0);
    const blockSize = ch0.length;

    // Mix mono into ring buffer and accumulate RMS
    for (let i = 0; i < blockSize; i++) {
      let sample = ch0[i];
      if (numCh > 1) sample = (sample + input.getChannelData(1)[i]) / 2;
      ring[writeHead % windowSamples] = sample;
      writeHead++;
    }

    totalSamples += blockSize;

    // ── Shazam fast path: fed EVERY block, independent of YAMNet ───────────
    // Deliberately outside the `!isProcessing` guard below: when inference runs
    // slower than the classification cadence the matcher would otherwise be
    // starved and never reach its minimum listen time. Pushing is a cheap
    // buffer copy; only tryMatch() (~20 ms) runs on a cadence.
    if (!constellationFired) {
      const mono = new Float32Array(blockSize);
      for (let i = 0; i < blockSize; i++) {
        mono[i] = numCh > 1 ? (ch0[i] + input.getChannelData(1)[i]) / 2 : ch0[i];
      }
      const blk16k = resampleBlockTo16k(mono, sr);

      if (rollingMatcher) {
        if (pendingFeed.length) {
          for (const buffered of pendingFeed) rollingMatcher.push(buffered);
          pendingFeed = [];
          pendingFeedSamples = 0;
          Logger.info('[Constellation] flushed pre-arm audio into the matcher');
        }
        rollingMatcher.push(blk16k);
      } else {
        // index still loading — hold recent audio so nothing is lost
        pendingFeed.push(blk16k);
        pendingFeedSamples += blk16k.length;
        while (pendingFeedSamples > PENDING_FEED_CAP && pendingFeed.length) {
          pendingFeedSamples -= pendingFeed.shift().length;
        }
      }

      const tNow = performance.now();
      if (rollingMatcher && tNow - lastFingerprintTry >= 900) {
        lastFingerprintTry = tNow;
        try {
          const cm = rollingMatcher.tryMatch();
          if (cm) {
            if (cm.score > bestFingerprint.score) {
              bestFingerprint = {
                score: cm.score,
                normalized: +(cm.normalized || 0).toFixed(3),
                label: cm.ref ? cm.ref.label : null,
              };
            }
            if (cm.matched && onFeaturesCallback) {
              constellationFired = true;
              Logger.info(`[Constellation] MATCH ${cm.ref.label} score=${cm.score} norm=${cm.normalized.toFixed(3)} after ${rollingMatcher.secondsBuffered().toFixed(1)}s`);
              onFeaturesCallback({
                _workerResult: {
                  status: 'fingerprint_match',
                  anomaly: cm.ref.label,
                  faultType: cm.ref.fault_type,
                  severity: cm.ref.severity || 'high',
                  sourceFile: cm.ref.source_file,
                  score: cm.score,
                  normalized: cm.normalized,
                  listenSeconds: +rollingMatcher.secondsBuffered().toFixed(1),
                },
                rms: 0,
              });
              return;
            }
          }
        } catch (fpErr) {
          Logger.warn('[Constellation] match failed, continuing with embedding path:', fpErr?.message);
        }
      }
    }

    // ── Classification gate: process every ~1 second, AFTER we have at least 1s of data ──
    // Use wall-clock timing instead of fragile modulo arithmetic to ensure classification fires reliably
    const now = performance.now();
    const hasEnoughData = totalSamples >= windowSamples;
    const timeSinceLastClassify = now - lastClassifyTime;

    if (hasEnoughData && timeSinceLastClassify >= 900 && !isProcessing) {
      lastClassifyTime = now;
      isProcessing = true;

      // Snapshot the full 1-second window in order from ring buffer
      const snapshot = new Float32Array(windowSamples);
      const start = writeHead;
      for (let i = 0; i < windowSamples; i++) {
        snapshot[i] = ring[(start + i) % windowSamples];
      }

      // Compute RMS over the FULL 1-second snapshot (not just the current block)
      // This prevents intermittent silence rejections when individual blocks are quiet
      let snapshotRmsSq = 0;
      for (let i = 0; i < windowSamples; i++) {
        snapshotRmsSq += snapshot[i] * snapshot[i];
      }
      const rms = Math.sqrt(snapshotRmsSq / windowSamples);

      const pcm16kRaw = resampleTo16k(snapshot, sr);

      // Hard RMS pre-gate to reject silence. 0.005 (was 0.01): phone mics with
      // AGC disabled capture quietly; level is equalized by normalization below,
      // so the gate only needs to exclude true silence.
      if (rms < 0.005) {
        if (onFeaturesCallback) {
          onFeaturesCallback({
            _workerResult: { status: 'normal', reason: 'rejected_silence' },
            rms: rms
          });
        }
        isProcessing = false;
        return;
      }

      try {
        // ── Make the live window mathematically identical to the reference
        // pipeline (scripts/build_reference_fingerprints.mjs):
        //   1. resample device rate → 16 kHz
        //   2. RMS-normalize to the SAME 0.05 target used for every reference
        // Without (2), quiet phone-mic captures embed differently from the
        // loudness-normalized references and similarity collapses.
        const pcm16k = pcm16kRaw;
        const normalized = rmsNormalize(pcm16k, 0.05);
        const analysis = await getAudioAnalysis(normalized);
        if (!analysis) {
          isProcessing = false;
          return;
        }

        const matchResult = findBestMatch(analysis.embedding, analysis.meanScores);

        if (onFeaturesCallback) {
          onFeaturesCallback({
            compositeEmbedding: analysis.embedding,
            _workerResult: matchResult,
            rms: rms
          });
        }
      } catch (err) {
        Logger.error('Classification error:', err);
      } finally {
        isProcessing = false;
      }
    } else if (!hasEnoughData) {
      // Compute block-level RMS for UI feedback while buffering
      let frameRmsSq = 0;
      for (let i = 0; i < blockSize; i++) {
        frameRmsSq += ch0[i] * ch0[i];
      }
      const blockRms = Math.sqrt(frameRmsSq / blockSize);

      if (onFeaturesCallback) {
        onFeaturesCallback({
          _workerResult: { status: 'buffering' },
          rms: blockRms
        });
      }
    }
  };

  // ScriptProcessor must connect to destination to fire
  mediaStreamSource.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);
  Logger.info('Main thread audio capture active');
}

export function stopExtraction() {
  isExtracting = false;
  rollingMatcher = null;
  constellationFired = false;

  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor.onaudioprocess = null;
    scriptProcessor = null;
  }

  if (mediaStreamSource) {
    mediaStreamSource.disconnect();
    mediaStreamSource = null;
  }

  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  onFeaturesCallback = null;
  Logger.info('🔴 Extraction stopped — all resources released');
}
