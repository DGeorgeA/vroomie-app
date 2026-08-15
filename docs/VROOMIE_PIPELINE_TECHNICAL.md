# Vroomie Audio Detection Pipeline — Technical Specification

**Engine v10.4 · derived from the shipped source, not from design intent.**
Every constant, threshold and artifact figure below was read out of the code and the deployed artifacts. File references are exact.

---

## 1. Architecture

Two independent matchers share one microphone stream. They are **additive**: the fingerprint path never suppresses the embedding path, and an unavailable fingerprint index degrades the system to embedding-only rather than breaking it.

```
navigator.mediaDevices.getUserMedia
  { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
                    │
       AudioContext at DEVICE NATIVE RATE (never forced to 16 kHz)
                    │
        ScriptProcessor, 4096-sample blocks (~85 ms @ 48 kHz)
                    │
        ┌───────────┴────────────────────────────┐
        │                                        │
  PATH A — FINGERPRINT                     PATH B — EMBEDDING
  every block, no gating                   1 s window, ~0.9 s cadence
  resampleBlockTo16k()                     resampleTo16k() → 16000 samples
        │                                        │
  rolling 5 s ring buffer                  silence gate: rms < 0.005 → reject
        │                                        │
  tryMatch() every ~0.9 s                  rmsNormalize(pcm, 0.05)
        │                                        │
  constellation hashing                    YAMNet → 1024-d embedding
  + time-offset coherence                          + 521 class scores
        │                                        │
  HIT → auto-finalise session              domain gate → margin rule
                                                  → session decision
```

**Files.** `src/lib/audioFeatureExtractor.js` (capture, routing) · `src/lib/constellationMatcher.js` (Path A, self-contained, zero imports) · `src/lib/mlEmbeddingEngine.js` (Path B) · `src/components/predictive/AudioRecorder.jsx` (session decision) · `scripts/build_reference_fingerprints.mjs` and `scripts/build_constellation_index.mjs` (offline artifact factories).

## 2. Capture

`TARGET_SR = 16000`, `SCRIPT_BUFFER_SIZE = 4096`.

**Native-rate capture, software resampling.** The AudioContext is created without a `sampleRate` constraint and resampling to 16 kHz is done in code. Forcing a 16 kHz context onto a `MediaStreamSource` is a known iOS Safari failure class (silence or `NotSupportedError` when the context rate differs from hardware). Two resamplers exist deliberately:

- `resampleTo16k(pcm, srIn)` — always emits exactly 16000 samples (one second), for Path B.
- `resampleBlockTo16k(block, srIn)` — proportional length, for Path A's per-block feed.

**Applied constraints are recorded, not assumed.** `track.getSettings()` is read back into `appliedCaptureSettings` and written into every session's diagnostics, because some Android builds silently ignore `noiseSuppression:false` — which attenuates exactly the broadband signatures the engine needs. A device forcing suppression logs a warning.

**Ordering matters and is deliberate.** Path A is fed *before* the silence gate and *outside* the `!isProcessing` guard that throttles Path B. Field telemetry showed two failure modes this ordering fixes: quiet-but-present audio being discarded before the level-invariant matcher could see it, and the matcher being starved whenever YAMNet inference exceeded the 900 ms cadence.

**Pre-arm buffering.** The fingerprint index is warmed 1.2 s after module load. Until it arms, blocks accumulate in `pendingFeed` (capped at `PENDING_FEED_CAP = 96000` samples = 6 s) and are flushed into the matcher the moment it is ready, so a cold-cache fetch no longer costs the opening seconds of a session.

## 3. Path A — constellation fingerprinting

Identifies *known reference recordings*. Self-contained module; no shared thresholds with Path B.

### 3.1 Parameters

| Constant | Value | Meaning |
|---|---|---|
| `NFFT` | 1024 | 64 ms window @ 16 kHz, 31.25 Hz/bin |
| `HOP` | 256 | 16 ms frame advance |
| `BANDS` | `[0,20,40,80,160,320,512]` | six log-spaced bin ranges |
| `PEAK_FACTOR` | 1.6 | peak must exceed its band mean by this |
| `FANOUT` | 6 | targets paired per anchor peak |
| `DT_MIN/DT_MAX` | 1 / 48 | pairing window in frames (16–768 ms) |
| `DF_MAX` | 160 | max frequency delta in bins |

### 3.2 Algorithm

1. **Spectrogram** — Hann-windowed 1024-point radix-2 FFT per frame, magnitude spectrum over 512 bins.
2. **Peak picking** — per frame, per band, the strongest bin is retained if it exceeds that band's mean by `PEAK_FACTOR`. Peaks are *relative* maxima, which is what makes the representation invariant to level and to broad EQ changes.
3. **Hashing** — each anchor peak pairs with up to `FANOUT` later peaks inside the `(DT, DF)` window. Each pair packs into a single 32-bit integer:

   `hash = (f1 & 0x1FF) << 15 | ((Δf + 256) & 0x1FF) << 6 | (Δt & 0x3F)`

   The anchor's absolute frame index is stored alongside.
4. **Matching by time-offset coherence** — for each query hash present in the index, every occurrence votes for the pair `(referenceId, referenceTime − queryTime)`. A genuine match aligns the *entire* recording, so votes pile into one offset bin; unrelated audio scatters them. The score is the height of the tallest single-offset bin.

This coherence requirement is the reason the path can be sensitive without being trigger-happy: unrelated audio cannot manufacture a consistent time alignment across hundreds of independent hashes.

### 3.3 Decision

```
normalised = score / min(queryHashCount, ref.hash_count)

instant   : score ≥ 600  AND normalised ≥ 0.050
sustained : score ≥ 480  AND normalised ≥ 0.042
            AND the same reference wins 2 consecutive attempts (~0.9 s apart)
matched   = instant OR sustained
```

**Why `min()` in the denominator.** Dividing by query hashes alone makes any reference shorter than the listen window structurally incapable of reaching the threshold. Measured: a genuine replay of an indexed 1.5 s reference peaked at 0.035 against a 0.05 requirement — it failed against *itself*. The artifact therefore ships `hash_count` per reference.

**Why a sustained tier exists.** The 600 threshold was derived from a simulated speaker channel where positives scored 621+. Real phone-through-speaker telemetry measured correct identifications at 494–553 — right labels, rejected by an over-tight bar. Lowering the bar alone was unsafe (the worst healthy negative measured 443), so the lower tier is paired with persistence: a real replay retains its identity across independent windows, a coincidental peak alignment does not.

`LISTEN_SECONDS = 5` (rolling ring buffer), `MIN_LISTEN_SECONDS = 3` (no attempt before this much audio).

### 3.4 Index

`public/constellation_v1.json` — 8 references, 155,288 entries, 1.6 MB, service-worker cached. Stored as two parallel base64 `Int32Array`s (`keys` sorted, `vals` packed as `refId << 20 | frameIndex`), hydrated at runtime into a `Map<hash, Int32Array>` using `subarray` views — no per-entry object allocation.

| Reference | Hashes |
|---|---|
| Alternator bearing noise | 22,318 |
| MotorStarter | 22,320 |
| Piston | 22,236 |
| PowerSteeringPump | 22,291 |
| RockerArmAndValve | 22,186 |
| SerpentineBelt | 22,250 |
| Intake leak | 10,899 |
| Timing chain rattle | 10,788 |

**Two deliberate exclusions**, both measured: `water_pump_failure_critical.wav` is a synthetic sine tone rather than a recording; `misfire_detected_medium.wav` is acoustically an *irregular idle* and produced the only two healthy false fires observed (496 and 523, sustained across four consecutive attempts, so persistence could not separate them). Misfire detection continues on Path B, which separates it using healthy anchors. A `MIN_REF_SECONDS = 4.0` floor also excludes the 1.5 s power-steering variants.

**Cost.** `tryMatch()` measures 22 ms median on desktop; roughly 8× headroom against the 900 ms cadence even assuming a phone 5× slower.

## 4. Path B — YAMNet embedding matching

Generalises to vehicles never seen before. Model: YAMNet via TensorFlow.js, executed entirely on-device, producing per-frame 1024-d embeddings and 521-class scores, mean-pooled across the 1 s window.

### 4.1 Stage 1 — acoustic domain gate

Decides whether the window is vehicle audio *before* any fingerprint comparison. Uses the 521 class scores, which the earlier architecture computed and discarded.

- `VEHICLE_MECH_INDICES` — 53 mechanical/vehicle classes (Engine, Idling, Rattle, Gears, Whir, Clatter, …). `Mechanical fan` and `Air conditioning` are deliberately **excluded**: household fans passed the gate and matched hiss-like references.
- `INTERFERER_INDICES` — the contiguous human-sound and music ranges plus Television, Radio, Silence, Whistling, Whistle.

```
accepted =  VEHICLE_MECH_INDICES.has(top1)
         || (!isInterferer && interfererScore < 0.15)        // GENERIC_INTERFERER_CEILING
         || (vehicleScore ≥ 0.03 && vehicleScore > interfererScore)   // VEHICLE_SCORE_FLOOR
         || (isInterferer && vehicleScore ≥ 0.02 && interfererScore ≤ 0.30)  // speaker rescue
```

The **generic-acoustics clause** exists because real faults frequently do not classify as vehicle sounds: measured, alternator bearing → "White noise"/"Waterfall", misfire → "Explosion"/"Rain", pump whine → "Sine wave". A strict vehicle-only gate discarded those windows entirely.

The **speaker-rescue clause** (v9.9) was added from field diagnosis: playback through a real speaker shifts YAMNet's top-1 toward Speech/Applause/Bell, and the previous hard interferer veto discarded windows that simultaneously carried vehicle evidence. Boundary measured on 70 vetoed fault windows vs 108 real speech/music windows — recovers 29, admits 0. Real speech sits at interferer 0.47–0.98 with vehicle evidence ≈ 0.001, far outside the clause.

### 4.2 Stage 2 — discriminative match

```
bestFault  = max cosine(liveEmbedding, faultRef)     over 352 fault embeddings
bestAnchor = max cosine(liveEmbedding, anchor)       over  94 anchors
margin     = bestFault − bestAnchor

candidate ⟺ bestFault ≥ 0.45 (ANOMALY_THRESHOLD) AND margin ≥ 0.04 (ANCHOR_MARGIN)
near      ⟺ bestFault ≥ 0.45 AND 0.02 ≤ margin < 0.04 (NEAR_ANCHOR_MARGIN)
```

**The anchors are the load-bearing invention.** YAMNet embeddings of any two sustained sounds sit at 0.7–0.9 cosine, so "nearest fault" is meaningless on its own. Measured: a healthy idling car scores **0.892–0.918** against power-steering references — higher than several genuine faults. The anchor set supplies the "compared to what?": 78 healthy engine anchors (idle, startup, braking; even-numbered Kaggle clips only, odd held out) plus 16 interferer anchors (four real speech recordings, white/pink noise at three levels, fan simulation, 440 Hz tone, synthetic music, traffic).

Near-band windows still count as **clean** — their `status` and `reason` are unchanged — so the primary rule is provably unaffected by the near tier's existence.

### 4.3 Stage 3 — session decision

In `AudioRecorder.jsx`, evaluated at stop:

```
accepted = cleanWindows + candidateWindows

PRIMARY   : one fault FAMILY holds ≥ 45% of accepted windows, min 3 accepted
RECOVERY  : nothing confirmed, but total candidates ≥ 60% of accepted
            → plurality family; on a hit-tie the leader's summed raw similarity
              must exceed the runner-up by ≥ 1.10×, else decline
NEAR      : nothing confirmed, and one family holds ≥ 85% of accepted windows
            in the near band → "POSSIBLE — VERIFICATION REQUIRED", 65–69%,
            severity capped at 'medium'
```

Votes aggregate by **fault family** (`fault_type`), not by individual label: three separate alternator-bearing references once split a 57%-candidate session three ways and confirmed nothing.

The recovery vote handles acoustic distance splitting one fault across two families — measured, a rocker arm at 2 m produced 8 of 12 confident candidate windows split 4/4 and reported nothing. The tie-break ranks by **raw similarity sum, not margin**: margin ranking picked the wrong family in 5 of 9 tied probe runs.

### 4.4 Confidence

```js
marginToConfidence(margin) = clamp(0.70 + 1.08 × (margin − 0.04), 0.70, 0.97)
```

Derived from the **margin** — the match strength after subtracting the best healthy/noise anchor — not from raw similarity, which sits at 0.7–0.9 for any two sustained sounds and previously produced meaningless "80% confidence" claims. A confirmed anomaly is therefore ≥70% by construction. Fingerprint hits report a fixed 97%; the near tier maps to 65–69%, strictly below the confirmed floor so the tiers cannot blur.

Published as: *"There is a 77% possibility that there could be a possible Piston (Piston.wav)"*.

## 5. Reference artifact factory

`public/fingerprints_v9.json` — 1024-d, int8-quantised (`value = min + byte × scale`), 352 fault embeddings, 94 anchors. Built offline; **never generated in the browser** (that cost every client an 11 MB download and minutes of startup).

**Pipeline per reference:** QC (reject synthetic tones by YAMNet dominant class, clips < 1 s, near-silent) → mono → 16 kHz → RMS-normalise to 0.05 → chunk selection → 8 augmentation variants → YAMNet → quantise.

| Variant | Purpose | Count |
|---|---|---|
| `orig` | baseline | 46 |
| `band` | phone-band filter | 43 |
| `noise` | +15 dB SNR noise | 44 |
| `rate+` / `rate-` | ±2% rate shift | 43 / 46 |
| `echo` | room reflection | 43 |
| `speaker` | gentle speaker replay | 44 |
| `phonespk` | harsh phone-speaker channel | 43 |

**Per-family cap of 100** prevents dataset dominance. Before it, `power_steering` held 376 of 560 embeddings (58.8%) and absorbed 8 of 9 healthy false alarms. Current distribution: alternator 100, power_steering 100, and 24 each for intake_leak, misfire, piston_knock, rocker_valve, serpentine_belt, timing_chain; motor_starter 8.

**Critical invariant: live windows and reference chunks must undergo mathematically identical preprocessing.** Both paths mono → 16 kHz → RMS-normalise to 0.05 → 1 s window. Measured parity: identical RMS after normalisation (0.05000 both), identical dimensions (1024 / 521); the residual embedding cosine of 0.9528 between direct and channel-simulated audio is the acoustic channel itself, not a preprocessing mismatch. There is **no FFT/Mel/MFCC stage** in Path B — YAMNet consumes normalised PCM directly.

## 6. Failure handling and diagnosability

Every abort path persists a hidden `status:'rejected'` row (filtered from all history UIs) carrying: window counts, silence-vs-domain rejection split, the top YAMNet classes the audio was heard as, the device's *applied* capture settings, the best fingerprint score even when it never cleared threshold, and the engine build.

Three abort conditions, each with a specific user-facing message — never a fabricated "healthy" result:

- zero windows analysed (model not ready / session too short)
- reference artifact failed to load
- majority of windows rejected → *"heard as ⟨class⟩ … N quiet / M non-vehicle of K windows · closest fingerprint ⟨label⟩ ⟨score⟩/600"*

A fingerprint hit bypasses all three: the audio *was* identified, so an "unable to detect" message would be false.

**This telemetry is what diagnosed the 13 August demo failure two days later without device access** — fingerprint scores of 79/167/88 against 549–736 for identical audio, with 37 of 42 windows still accepted, isolating Zoom's acoustic echo cancellation as the cause.

## 7. Measured performance

| Measure | Result | Harness |
|---|---|---|
| Stress matrix — 8 refs × 4 channels × 4 volumes × 3 offsets | **384/384 (100%)** | `stress_detection_matrix.mjs` |
| Fingerprint false fires — 140 held-out healthy clips | **0** | `verify_sustained_tier.mjs` |
| Fingerprint false fires — 9 interferers | **0** (worst 56) | `verify_sustained_tier.mjs` |
| Embedding healthy false alarms | 6/140 (4.3%) | `rca_healthy_fp_sweep.mjs` |
| Held-out unseen fault recall (embedding) | ~2 in 3 | `benchmark_discrimination.mjs` |
| Fingerprint latency | ~3.7 s | stress matrix |
| `tryMatch` cost | 22 ms median | timing probe |

## 8. Operating constraints

- Path A recognises **exact recordings**, not fault categories — the same limitation that lets Shazam identify a studio track but not a cover. Real-vehicle coverage rests entirely on Path B.
- Nine fault families are supported; injector tick and exhaust leak have no reference audio and cannot be detected at all.
- `intake_leak` replay is partially suppressed by the broadband-noise anchors that provide fan immunity — an intake leak *is* a hiss. A genuine tension, not a defect.
- Devices that force noise suppression may attenuate signatures; now visible per session in `capture_settings`.
- Both accuracy figures in §7 are bounded by reference-library size, not by algorithm design.
