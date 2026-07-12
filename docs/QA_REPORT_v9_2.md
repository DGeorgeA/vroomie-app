# QA Report — Audio Pipeline v9.2

Date: 2026-07-07 · Scope: possibility statement (≥70%, noise-discounted),
vehicle-motion gate, and regression assurance over the full detection stack.
All checks below were executed against this exact working tree; commands are
reproducible from the repo.

## QA-1 — Detection accuracy (held-out, 91 sessions)
Harness: `scripts/benchmark_discrimination.mjs` (12 s sessions; evaluation
clips are ODD-numbered Kaggle files, disjoint from the EVEN-numbered clips used
to build anchors).

| Set | Sessions | Result | Verdict |
|---|---|---|---|
| Healthy idle (held-out) | 15 | 0 false anomalies | PASS |
| Healthy startup (held-out) | 10 | 0 false anomalies | PASS |
| Healthy braking (held-out) | 10 | 0 false anomalies | PASS |
| Speech ×2, TV mix, music | 4 | 0 false anomalies | PASS |
| White noise (2 levels), pink noise, fan sim, pure tone | 5 | 0 false anomalies | PASS |
| Silence | — | rejected at RMS gate (cannot reach matcher) | PASS |
| Held-out raw fault clips (power steering / serpentine / low oil) | 36 | 14 detected | documented limit |
| Supabase reference replay (11 usable WAVs) | 11 | **10 detected, correct label each** | PASS (miss: `intake_leak_low`, see limits) |

## QA-2 — Possibility statement (27 unit checks)
Harness: `scripts/qa_unit_tests.mjs` → **ALL PASSED** (exit 0).

- Mapping: possibility = 70% exactly at the qualifying margin (0.05); saturates
  at 97%; monotonic; can never publish < 70% or > 97%. Source-drift guard
  confirms the tested constants are the shipped constants.
- Format: `There is a 82% possibility that there could be a possible Piston
  (Piston.wav)` — exact match to the product requirement; parenthetical file
  name omitted only if unknown.
- Real statements generated from measured reference replays (10/10 ≥ 70%):
  Piston 80%, BearingAlternator 83%, MotorStarter 87%, misfire 91%,
  RockerArmAndValve 86%, PowerSteeringPump 92%, SerpentineBelt 92%,
  timing chain 97%, alternator bearing critical 79%, combined PS set 76%.

## QA-3 — Vehicle-motion gate (unit + wiring checks)
- Synthetic-trace classifier: still phone → `still` (rms 0.0016); idle-engine
  vibration → `moving` (rms 0.083); hand-held phone → `moving` (rms 0.178,
  can never be suppressed); < 2 s of data or no sensor events → `insufficient`
  → fail-open. All PASS.
- Wiring: suppression requires `available && verdict === 'still'` AND at least
  one confirmed anomaly — healthy reports are never motion-blocked; desktops /
  denied permission skip the check. Source-level checks PASS.
- Not covered by automation: real accelerometer streams on physical devices
  (requires hands-on device testing — see sign-off).

## QA-4 — Decision invariance
The v9.2 changes (confidence remap, statement fields, motion gate) do not touch
τ / margin / fraction constants or the artifact. `scripts/rule_explorer.mjs`
re-run on the frozen measurement dump reproduces the v9.1 table exactly
(fraction δ=0.05 f=0.5: healthy 0/35, interferer 0/9, faults 14/36, bucket
10/11). PASS.

## QA-5 — Build & boot
- `npm run build`: clean, no errors; PWA precache 43 entries incl. the
  fingerprint artifact. PASS.
- Production bundle boot (headless preview): app renders, Start Recording
  present, `fingerprints_v9.json` serves (432 faults / 93 anchors), zero
  console errors, DeviceMotion API detected. PASS.

## QA-6 — Data-integrity spot checks
- Reference artifact: 432 fault embeddings from 54 QC-passing bucket WAVs;
  synthetic sine-tone water pump auto-rejected by QC (logged). PASS.
- Anomaly payloads now carry `possibility`, `sourceFile`, `statement` —
  additive JSONB fields; existing reports unaffected. PASS.

## Failures / limits carried forward (not regressions)
1. `intake_leak_low` replay suppressed — an intake leak is acoustically white
   noise; the anchors that provide fan/ambient immunity out-score it. Fix path:
   a distinctive real intake-leak recording in the bucket.
2. `water_pump_failure_critical.wav` remains a synthetic tone → class disabled
   by QC until a real recording replaces it.
3. Raw-recording recall 14/36 is reference-dataset-bound (processed 1.5 s
   clips). Real phone-mic fault recordings uploaded to the bucket are the
   highest-leverage improvement and are picked up automatically.

## Sign-off checklist for release
- [x] Zero false anomalies across every negative class tested (45 sessions)
- [x] Possibility statements ≥ 70%, correctly formatted, file-named
- [x] Motion gate fail-open verified at unit level
- [ ] Physical-device pass (user): real car idle + TV-in-living-room session
      on an actual phone — the final gate the harness cannot automate
