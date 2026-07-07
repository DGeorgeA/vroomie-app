# Anomaly Detection Accuracy — Root Cause & Validation Evidence

Date: 2026-07-07 (updated same day: full-bucket references + 0.60 threshold)
Scope: detection engine + reference loading (`src/lib/mlEmbeddingEngine.js`,
`src/lib/audioFeatureExtractor.js`, `src/lib/datasetLoader.js`,
`src/data/yamnet_classes.js`). Waveform, report generation, and UI untouched.

## Root cause (measured, not theorized)

The engine classified a 1-second window as a fault when the cosine similarity between its
YAMNet mean embedding and any fault fingerprint was ≥ 0.75. **No check existed that the
window contained vehicle audio at all.** YAMNet's 521-class scores output — which directly
recognises Speech, Music, Television, Silence vs Engine, Vehicle, Mechanisms — was computed
on every inference and then discarded (`mlEmbeddingEngine.js` used only the embeddings tensor).

Measured on the production pipeline (offline replica, identical fingerprint generation,
windowing, and 0.75 threshold — `scripts/validate_anomaly_accuracy.mjs`):

| Live audio | Best fingerprint match | Cosine | Old verdict |
|---|---|---|---|
| Ambient room noise (broadband) | `intake leak low` | **0.86 – 0.89** | **ANOMALY (false)** |
| TTS speech (4 voices/styles) | `misfire detected medium` | 0.20 – 0.47 | normal |
| TV-style speech + music bed | `alternator bearing fault critical` | 0.18 – 0.45 | normal |
| Known fault recordings | their own reference | 1.00 | anomaly (correct) |

Any real room's broadband noise floor is embedding-wise ≈ a leak/bearing hiss, so a session
recorded near a TV or in a quiet room accumulates ≥ 0.75 matches and publishes a fault
report. This is the "Power Steering Combined No Oil Serpentine Belt on silence" failure mode
(that label comes from the power-steering Kaggle reference set — same mechanism).

## Fix

Three-stage decision, replacing similarity-only:

1. **Acoustic domain gate** (new): each window's mean YAMNet class scores are checked.
   The window is eligible for fingerprint matching only if the strongest
   vehicle/mechanical class (Engine, Idling, Rattle, …, 53 classes) beats the strongest
   interferer class (all human sounds, all music, Television, Radio, Silence — 216 classes)
   and reaches a 0.03 floor, or a vehicle class is the top-1 overall. Rejected windows
   count toward the existing session rejection gate, so speech/TV/silence sessions end in
   "Unable to detect vehicle audio" instead of a report.
2. **Fingerprint similarity**: cosine ≥ **0.60** (product requirement 2026-07-07; was 0.75)
   against the reference set — the anomaly is categorized by the matching reference's
   file name.
3. **Persistence** (new): a fault label must match in 2 windows within the session
   (or a single window at ≥ 0.95) before it is reported.

**Reference set** (`src/lib/datasetLoader.js`): the `anomaly-patterns` Storage bucket is
listed at runtime and EVERY `.wav` in it is fingerprinted — 55 files / 119 chunk
embeddings at validation time (was a hardcoded 6-file subset). Numbered variants
(`Issue_with_Power_steering_or_low_oil_or_serpentine_belt_2/4/…/88.wav`) collapse into one
anomaly category derived from the file name. Max 3 evenly-spaced 1-second chunks per file;
embeddings rounded to 4 decimals to fit localStorage (cache key `…_v8`, old `…_v7` removed).
Uploading a new sample to the bucket adds it to the matcher with no code change.

`src/data/yamnet_classes.js` was regenerated from the canonical
`yamnet_class_map.csv` (the previous file was a corrupted CSV paste with shifted indices;
it was unused). `scripts/generate_class_map_js.mjs` reproduces it.

## Validation evidence (full bucket, threshold 0.60 vs 0.75)

### Controlled matrix — `scripts/validate_anomaly_accuracy.mjs` (21 sessions, 147 windows)

Negatives: digital silence, near-silent room, audible ambient noise, synthetic music,
4 TTS speech clips (2 voices), TV-style speech+music. Positives: 12 reference fault
recordings (bearing ×2, starter, piston, power steering pump, serpentine belt,
rocker/valve, intake leak, misfire, timing chain, water pump, combined power-steering set).

| Pipeline (gate + persistence in both) | False positives | False negatives |
|---|---|---|
| **SHIP @ 0.60** | **0/9** | **1/12** (water pump — see below) |
| PREV @ 0.75 | 0/9 | 1/12 (same file) |

Reference: the original similarity-only engine scored 1/9 FP (ambient noise → "intake
leak" at 0.88) with no gate.

The single false negative is `water_pump_failure_critical.wav` itself: YAMNet identifies
that file as a **pure synthetic sine tone** ("Sine wave" 0.57, constant across all 5
seconds) — it is a placeholder, not a recording of a water pump. The domain gate correctly
refuses to classify synthetic tones as vehicle audio (weakening it to accept sine waves
would make alarm beeps and test tones matchable). Fails identically at 0.75, so it is
unrelated to the 0.60 threshold. Fix: upload a real water-pump recording to the bucket —
it will be fingerprinted automatically.

### Regression sweep — `scripts/regression_sweep_kaggle.mjs` (60 sessions, real car audio)

- Healthy audio (normal idle ×12, normal startup ×12, normal brakes ×12):
  **0/36 false anomalies at 0.60.**
- Raw Kaggle fault clips (low oil / serpentine / power steering / worn brakes /
  bad ignition / dead battery): no false cross-labels. Note: the raw Kaggle
  low-oil/serpentine/power-steering clips do not reach 0.60 against the bucket's processed
  variants of the same dataset — cross-recording generalization is limited; the matcher
  detects sounds acoustically close to its actual reference recordings.
- Total across both suites: **81 sessions, 0 false anomalies, 11/12 reference faults
  detected** (the 12th being the synthetic-tone placeholder above).

### Build & boot

`npm run build` passes; production bundle boots with zero console errors; recorder UI and
waveform render (verified via headless preview).

## Known residual limits (honest)

- `water_pump_failure_critical.wav` is a synthetic sine tone and cannot be detected until
  replaced with a real recording (see above).
- Detection generalizes to sounds acoustically similar to the bucket recordings; a fault
  recorded under very different conditions (mic, distance, vehicle) may fall below 0.60.
  More reference samples per fault → better coverage; they are picked up automatically.
- Sustained audio that is engine-like AND ≥ 0.60 similar to a reference for 2+ windows
  will flag — that is the design of fingerprint matching, restricted to the vehicle domain.
- First run after this change regenerates fingerprints (55 files, ~11 MB download + YAMNet
  embedding in-browser); subsequent runs use the localStorage cache (`…_v8`).
