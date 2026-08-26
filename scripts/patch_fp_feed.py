"""
Decouple the constellation fingerprint feed from YAMNet's processing cadence,
and warm the index before the user ever presses record.

Two measured intermittency causes:
  1. loadConstellationIndex() only started at startExtraction — a 1.7 MB fetch,
     so on a cold cache the matcher armed seconds late and short recordings were
     never fingerprinted.
  2. The feed lived inside the `!isProcessing` guard, so whenever YAMNet
     inference ran longer than the 900 ms cadence the matcher was starved and
     never reached its 3 s minimum.
"""
import io

P = "src/lib/audioFeatureExtractor.js"
s = io.open(P, encoding="utf-8").read()

# ── 1. general-length block resampler + pending pre-arm buffer ──────────────
anchor = "// Identical to the reference factory's loudness normalization"
addition = """// Variable-length block resampler for the fingerprint feed. resampleTo16k()
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

"""
assert s.count(anchor) == 1
s = s.replace(anchor, addition + anchor)

# ── 2. pre-arm buffer state ────────────────────────────────────────────────
old_state = "let bestFingerprint     = { score: 0, normalized: 0, label: null };"
new_state = (old_state + "\n"
             "// Audio captured BEFORE the index finished loading. Flushed into the matcher\n"
             "// the moment it arms, so a slow first fetch no longer costs the opening\n"
             "// seconds of the session (a measured cause of intermittent detection).\n"
             "let pendingFeed         = [];\n"
             "let pendingFeedSamples  = 0;\n"
             "const PENDING_FEED_CAP  = TARGET_SR * 6;")
s = s.replace(old_state, new_state)

# ── 3. warm the index at module load, long before record is pressed ────────
warm_anchor = "// ─── Public API ───────────────────────────────────────────"
warm = """// Warm the fingerprint index shortly after this module loads — well before the
// user presses record. Previously the 1.7 MB fetch only began at startExtraction,
// so a cold cache meant the fast path armed several seconds into the session.
if (typeof window !== 'undefined') {
  setTimeout(() => { loadConstellationIndex().catch(() => {}); }, 1200);
}

"""
assert s.count(warm_anchor) == 1
s = s.replace(warm_anchor, warm + warm_anchor)

# ── 4. reset pending on start ──────────────────────────────────────────────
s = s.replace("  bestFingerprint    = { score: 0, normalized: 0, label: null };",
              "  bestFingerprint    = { score: 0, normalized: 0, label: null };\n"
              "  pendingFeed        = [];\n  pendingFeedSamples = 0;")

# ── 5. move the feed OUT of the YAMNet-guarded block ───────────────────────
old_block_start = s.find("      // Resample FIRST so the fingerprint fast path sees every window — see below.")
old_block_end = s.find("      // Hard RMS pre-gate to reject silence.")
assert old_block_start > 0 and old_block_end > old_block_start
s = s[:old_block_start] + "      const pcm16kRaw = resampleTo16k(snapshot, sr);\n\n" + s[old_block_end:]

# insert the decoupled feed right after the ring-buffer fill
ring_anchor = """    totalSamples += blockSize;
"""
feed = """    totalSamples += blockSize;

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
"""
assert s.count(ring_anchor) == 1
s = s.replace(ring_anchor, feed)

# ── 6. per-capture cadence timer ───────────────────────────────────────────
s = s.replace("  let lastClassifyTime = 0; // Timestamp of last classification attempt",
              "  let lastClassifyTime = 0; // Timestamp of last classification attempt\n"
              "  let lastFingerprintTry = 0; // fingerprint cadence, independent of YAMNet")

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("patched: block resampler, pre-arm buffer, module warmup, decoupled feed")
