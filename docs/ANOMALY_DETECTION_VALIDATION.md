# Anomaly Detection Accuracy — Root Cause & Validation Evidence

Date: 2026-07-07
Scope: detection engine only (`src/lib/mlEmbeddingEngine.js`, `src/lib/audioFeatureExtractor.js`,
`src/data/yamnet_classes.js`). Waveform, report generation, UI, dataset, and thresholds
were intentionally left untouched.

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
2. **Fingerprint similarity** (unchanged): cosine ≥ 0.75 against the same reference set.
3. **Persistence** (new): a fault label must match in 2 windows within the session
   (or a single window at ≥ 0.95) before it is reported.

`src/data/yamnet_classes.js` was regenerated from the canonical
`yamnet_class_map.csv` (the previous file was a corrupted CSV paste with shifted indices;
it was unused). `scripts/generate_class_map_js.mjs` reproduces it.

## Validation evidence

### Controlled matrix — `scripts/validate_anomaly_accuracy.mjs` (15 sessions, 129 windows)

Negatives: digital silence, near-silent room, audible ambient noise, synthetic music,
4 TTS speech clips (2 voices), TV-style speech+music. Positives: the 6 known fault
recordings (bearing ×2, starter, piston, intake leak, misfire).

| Pipeline | False positives | False negatives |
|---|---|---|
| Old (HEAD) | 1/9 (ambient → "intake leak") | 0/6 |
| **Fixed** | **0/9** | **0/6** |

### Regression sweep — `scripts/regression_sweep_kaggle.mjs` (60 sessions, real car audio)

36 healthy sessions (normal idle ×12, normal startup ×12, normal brakes ×12) and
24 unseen-fault sessions (low oil, serpentine belt, power steering, worn brakes,
bad ignition, dead battery — no fingerprints exist for these classes).

- Healthy audio false anomalies: **0/36** (old engine: 1/36 — a 1.5 s idle clip at 0.924
  vs the bearing reference; caught by the 0.95 single-window bar + persistence).
- Unseen faults: no false cross-labels; sessions end HEALTHY or REJECTED, never a wrong
  fault name.
- Total across both suites: **75 sessions, 0 false anomalies, 6/6 known faults detected.**

### Build & boot

`npm run build` passes; production bundle boots with zero console errors; recorder UI and
waveform render (verified via headless preview).

## Known residual limits (honest)

- The reference set contains only 6 fault recordings; serpentine belt / power steering /
  rocker-valve faults present in `anomaly-patterns` are not in `FILES_TO_DOWNLOAD` and
  therefore cannot be detected. Dataset expansion was deliberately out of scope (Phase 0).
- Sustained audio that is both engine-like AND ≥ 0.75 similar to a reference for 2+ seconds
  will still flag — that is the design of fingerprint matching, now correctly restricted to
  the vehicle domain.
- Users with a cached fingerprint set in localStorage keep the same `v7` cache key; the fix
  is decision-layer only, so no cache invalidation is needed.
