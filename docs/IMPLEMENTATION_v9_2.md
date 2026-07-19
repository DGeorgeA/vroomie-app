# Vroomie Audio Pipeline v9.2 — Implementation & Finetuning Description

Date: 2026-07-07 · Commit series: abec5f2 → 19baef7 → 487c37a → cbf68f8 → v9.2
Companion documents: `docs/ANOMALY_DETECTION_VALIDATION.md` (v9/v9.1 evidence),
`docs/QA_REPORT_v9_2.md` (QA results for this release).

---

## 1. What the pipeline does (production flow)

```
User taps Start Recording
  ├── Motion capture starts (accelerometer, user-gesture context for iOS)
  └── Mic capture starts (16 kHz mono, no browser noise processing)
        ↓ every ~0.9 s: last 1 s of audio
      YAMNet (on-device): 1024-d embedding + 521-class scores
        ↓
      Stage 1 — RMS gate: silence rejected
      Stage 2 — Acoustic domain gate: speech/TV/music/broadcast rejected;
                generic acoustics pass only when interferer evidence < 0.15
      Stage 3 — Noise-discounted match:
                bestFault  = max cosine vs 432 fault reference embeddings
                bestAnchor = max cosine vs 93 healthy-engine/noise anchors
                margin     = bestFault − bestAnchor   ← "discounting the noise"
                candidate iff bestFault ≥ 0.60 AND margin ≥ 0.05
        ↓ on Stop
      Session decision: a fault is confirmed iff ≥ 50% of gate-accepted
                windows are candidates for it (min 4 windows)
      Vehicle-motion gate: anomaly published only if vehicle vibration was
                sensed (fail-open when sensors are unavailable)
        ↓
      Report: "There is a X% possibility that there could be a possible
               <ANOMALY NAME> (<file name in Supabase>)"
```

References are built OFFLINE from the `anomaly-patterns` Supabase bucket by
`scripts/build_reference_fingerprints.mjs` (QC → loudness normalization →
mic/room augmentation → YAMNet embedding → int8 quantization) and shipped as
`public/fingerprints_v9.json`. To add/replace a fault sample: upload the WAV to
the bucket, re-run the factory, commit the regenerated JSON.

## 2. The ≥ 70% possibility statement

The reported percentage is NOT raw cosine similarity (raw cosine is 0.7–0.9
between almost any two sustained sounds and was the source of the old
misleading "80% confidence"). It is calibrated from the **margin** — the match
strength left after subtracting the best healthy-engine/ambient-noise anchor
score, i.e. the match with the noise around the anomaly discounted:

```
possibility = clamp(70% + 108 × (margin − 0.05), 70%, 97%)
```

An anomaly is only ever confirmed at margin ≥ 0.05, so every published
statement is ≥ 70% by construction; a decisive margin (≥ 0.30) saturates at
97%. Measured statements from reference replays: Piston 80%, BearingAlternator
83%, MotorStarter 87%, misfire 91%, PowerSteeringPump 92%, SerpentineBelt 92%,
timing chain 97%, combined power-steering set 76%.

The statement text (report card, toast, and stored in
`analyses.anomalies_detected[].statement`):

> "There is a 92% possibility that there could be a possible PowerSteeringPump (PowerSteeringPump.wav)"

Healthy sessions report the window agreement rate instead; no hard-coded
defaults exist anywhere in the confidence chain.

## 3. Vehicle-motion gate ("is the user at a vehicle?")

`src/lib/motionDetector.js` samples `devicemotion` during recording and
high-passes the accelerometer to measure vibration RMS:

- Running-engine vibration measures ≈ 0.05–0.3 m/s²; hand-held tremor ≈
  0.05–0.2 m/s²; a phone lying still in a quiet room ≈ 0.001–0.01 m/s².
  Threshold: 0.03 m/s².
- **Anomaly reports require sensed vibration.** A phone left on a couch in
  front of a TV can no longer publish a fault report even if anomaly-like
  audio is heard — the session ends with "no vehicle vibration was sensed".
- **Fail-open**: desktops without sensors, browsers without DeviceMotion, and
  users who deny the iOS motion permission skip the check entirely; healthy
  reports are never blocked by motion. Suppression requires the device to have
  demonstrably measured stillness for ≥ 2 s of samples.
- iOS 13+ permission is requested inside the Start-Recording tap (required
  user-gesture context).

## 4. Finetuning history (what was measured and adjusted)

| Stage | Change | Measured reason |
|---|---|---|
| v8 → v9 | Offline reference factory + healthy anchors + margin rule | Healthy idle scored 0.80–0.92 vs the 44-file power-steering set (74–81% of references) — every car collapsed to that label |
| v9 | Session fraction rule (≥50% of windows, min 4) replaced 2-hit persistence | Streaming variants leaked 1–2 healthy FPs; end-of-session evaluation measured 0 |
| v9.1 | Domain gate admits generic acoustics when interferer < 0.15 | Real faults classify as "White noise"/"Explosion"/"Sine wave" and were gate-dropped; replayed bucket samples went undetected (5–6/11 → 10/11) |
| v9.1 | Interferer anchors 10 → 15 (noise ×3 levels, pink, fan, tone) | Gate now admits broadband/tonal audio; anchors must win the margin race instead |
| v9.2 | Possibility mapping recalibrated to [70%, 97%] + statement format + source file plumbing | Product requirement: ≥70% noise-discounted match → explicit possibility statement naming the Supabase file |
| v9.2 | Vehicle-motion gate | Product requirement: trigger only when vehicle presence is sensed |

Constants: τ = 0.60 (cosine), margin δ = 0.05, session fraction = 0.5, min
accepted windows = 4, gate interferer ceiling = 0.15, vibration threshold =
0.03 m/s². Every one of these was selected from measured grids
(`scripts/benchmark_discrimination.mjs`, `scripts/rule_explorer.mjs`), not
hand-tuned.

## 5. Known limits (unchanged claims, stated honestly)

- `intake_leak_low` replay is suppressed by the broadband-noise anchors (an
  intake leak IS a hiss) — the one reference of 11 that does not replay.
- `water_pump_failure_critical.wav` is a synthetic sine tone; QC excludes it.
  Upload a real recording to enable the class.
- Held-out raw-recording recall is 14/36: the reference set is processed 1.5 s
  clips. Real phone-mic recordings of real vehicles uploaded to the bucket
  remain the highest-leverage improvement; they are picked up automatically by
  the factory.
- Motion gate cannot verify "in a car" on desktops or when permission is
  denied — it fails open by design rather than blocking legitimate use.
