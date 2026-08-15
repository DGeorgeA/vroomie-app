# Vroomie — Session Handoff

**Purpose:** everything a new conversation needs to continue this work without re-deriving it. Written because the previous chat's context window filled. Read this first; it replaces the transcript.

**State as of 15 August 2026 · engine v10.4-FIELD-CALIBRATED · live at vroomie.in**

---

## 1. Coordinates

| | |
|---|---|
| Repo | `github.com/DGeorgeA/vroomie-app` · branch `main` |
| Local | `C:\Users\Deepak G A\Desktop\GoFriday_App\Vroomie\vroomie-app` |
| Live | https://vroomie.in (GitHub Pages, auto-deploy on push to main) |
| Supabase | project `bdldmkhcdtlqxaopxlam` · bucket `anomaly-patterns` · table `analyses` |
| Source audio | `..\audio_files\*.wav` (6 originals) + `extended_10s\` (10 s versions) |
| Kaggle dataset | `..\audio_files\Kaggle_dataset\archive\car diagnostics dataset` |

**Standing instruction from the user: PRESERVE the current detection logic. Do not change it without explicit review and approval.**

## 2. What the system is

Two matchers over one microphone, additive — the fingerprint never suppresses the embedding path.

**Fingerprint path (Shazam-style constellation hashing)** — identifies *known reference recordings* in ~3.7 s, auto-finalises the session. Cannot generalise to a different vehicle (same limitation as Shazam vs a cover version).

**Embedding path (YAMNet)** — generalises to any vehicle. Asks *"closer to a known fault than to a healthy engine?"* rather than *"which fault is nearest?"*. That distinction is why the app can report "nothing wrong" instead of hallucinating faults.

Full technical detail: `docs/VROOMIE_AUDIO_PIPELINE_EXPLAINED.md` and `docs/VROOMIE_DETECTION_ARCHITECTURE_V10.md`.

## 3. Current operating point — DO NOT CHANGE WITHOUT MEASURING

**Fingerprint** (`src/lib/constellationMatcher.js`)
```
MIN_COHERENT_SCORE        = 600     instant tier
MIN_NORMALIZED_SCORE      = 0.05
SUSTAINED_COHERENT_SCORE  = 480     + same ref on 2 consecutive attempts
SUSTAINED_NORMALIZED_SCORE= 0.042
LISTEN_SECONDS = 5, MIN_LISTEN_SECONDS = 3
normalised = score / min(queryHashes, ref.hash_count)
```

**Embedding** (`src/lib/mlEmbeddingEngine.js`)
```
ANOMALY_THRESHOLD = 0.45   ANCHOR_MARGIN = 0.04   NEAR_ANCHOR_MARGIN = 0.02
VEHICLE_SCORE_FLOOR = 0.03  GENERIC_INTERFERER_CEILING = 0.15
WEAK_INTERFERER_VEHICLE_FLOOR = 0.02  WEAK_INTERFERER_CEILING = 0.30
```

**Session** (`src/components/predictive/AudioRecorder.jsx`)
```
SESSION_FRACTION = 0.45   SESSION_MIN_ACCEPTED = 3
RECOVERY_TOTAL_FRACTION = 0.60   RECOVERY_DOMINANCE = 1.10
NEAR_SESSION_FRACTION = 0.85     (65-69% "possible" tier)
```

**Artifacts:** `public/constellation_v1.json` (8 refs, 155k entries) · `public/fingerprints_v9.json` (352 embeddings, 94 anchors)

## 4. Measured performance

| Measure | Result |
|---|---|
| Stress matrix — every ref × 4 channels × 4 volumes × 3 offsets | **384/384 (100%)**, slowest fire 8.4 s |
| Fingerprint false fires — 140 held-out healthy clips | **0** |
| Fingerprint false fires — 9 interferers | **0** (worst score 56; synth music 235) |
| Embedding healthy false alarms | 6/140 (4.3%) |
| Held-out unseen fault recall (embedding) | ~2 in 3 |
| Fingerprint match latency | ~3.7 s |
| `tryMatch` CPU cost | 22 ms median (~8× headroom on mobile) |

## 5. The 13 August demo failure — RESOLVED, no code fault

Meeting 1:23–1:25 pm IST. Telemetry shows fingerprint scores of **79, 167, 88** versus **549–736** for identical audio outside the meeting.

**Cause: Zoom's Acoustic Echo Cancellation.** Playing the sample through the laptop speaker while the laptop mic captured it — AEC exists precisely to subtract the machine's own playback from the mic feed. Vroomie received audio with its target signal deliberately removed. Confirmed by two facts: the fingerprint is level-invariant (a sample at 1/50th volume still scores 4,596, so this cannot be a volume issue), and windows were still *accepted* (42 analysed, 37 accepted) — audio was arriving and sounded vehicle-like, but the fine peak structure was gone. The ceiling fan compounded it; alone a fan scores 47 and never fires.

**Demo protocol going forward:** run Vroomie on a **phone**, keep the call on the laptop. Never let a conferencing app own the microphone Vroomie is using. Play the sample from a *different* device than the one capturing.

## 6. Test harnesses — run these, don't rebuild them

| Question | Script |
|---|---|
| Will detection hold across capture conditions? | `stress_detection_matrix.mjs` (the pre-demo confidence test) |
| Are fingerprint thresholds still safe? | `verify_sustained_tier.mjs` → prints SAFE TO SHIP / DO NOT SHIP |
| Embedding false-positive baseline | `rca_healthy_fp_sweep.mjs` (all 140 — never a stride sample) |
| Fingerprint index build | `build_constellation_index.mjs` |
| Embedding reference build | `build_reference_fingerprints.mjs` |
| Fast policy assertions | `qa_unit_tests.mjs`, `qa_ethanol_feature.mjs` |
| Markdown → PDF | `md_to_pdf.py <in.md> <out.pdf> "<subtitle>" "<version>" "<version line>" "<cover blurb>"` |
| Styled deck → PDF | headless Chrome `--print-to-pdf` on `docs/vroomie_gomechanic_deck.html` |

## 7. Hard-won lessons — do not repeat these

1. **A green `npm run build` does NOT prove the app boots.** A temporal-dead-zone error (`const` read before declaration) compiled fine and shipped a blank white site. Always load the built bundle before pushing.
2. **Never calibrate thresholds from simulation alone.** The 600 threshold came from a simulated channel where positives scored 621+; real devices scored 494–553, so correct identifications were being rejected. Real-device telemetry is the only authority.
3. **Never quote a stride sample as a rate.** "0/35 healthy false positives" was 15 of ~132 available clips. The true rate on the full set was 6.4%.
4. **Never reject an idea after testing one configuration.** The 65–72% tier was rejected on one setting (7/35 false alarms); a parameter sweep found a corner with zero.
5. **More reference copies ≠ more information.** Duplicating one recording into a longer file added near-duplicate embeddings, widened the family's territory and *increased* false alarms. Diversity of real recordings is what helps.
6. **Do not lower thresholds to fix recall.** Measured: it produces a 20% healthy false-positive rate. Improve discrimination instead.
7. **Anchors are load-bearing.** A healthy idling car scores 0.892–0.918 against power-steering references. Similarity without "compared to what?" is meaningless.
8. **Clean up test rows.** E2E tests write to the production `analyses` table (`vehicle_id: 'guest-vehicle'`); `flagged` rows appear in the user's history as real faults.

## 8. Deliverables produced

| Document | Path |
|---|---|
| Incident + pipeline explainer | `docs/VROOMIE_AUDIO_PIPELINE_EXPLAINED.md` + PDF |
| Detection architecture v10 | `docs/VROOMIE_DETECTION_ARCHITECTURE_V10.md` + PDF |
| Engineering handover | `docs/VROOMIE_ARCHITECTURE_HANDOVER.md` + PDF |
| Investor overview | `docs/VROOMIE_INVESTOR_OVERVIEW.md` + PDF |
| GoMechanic deck (6 pages, styled) | `docs/vroomie_gomechanic_deck.html` → `Vroomie_GoMechanic_Deck_Styled.pdf` |
| GoMechanic brief (text) | `docs/VROOMIE_GOMECHANIC_DECK.md` + PDF |

## 9. Open items

- **Physical validation across handset models** — all acoustic figures are simulation or in-app injection plus limited real-device telemetry.
- **Reference library is the binding constraint.** Real phone-recorded fault audio from real vehicles improves both the 4.3% false-alarm rate and the ~2-in-3 recall, with no code change. Highest-leverage investment.
- **Piston / Serpentine enrichment failed and was reverted** — each has only one source recording, so "enrichment" duplicated it. Needs genuinely different recordings from other vehicles.
- **Upload `audio_files/extended_10s/*.wav`** to the bucket so it matches the local index sources.
- **Ethanol feature ships disabled**; enable from Settings as admin (`dg8010@gmail.com`).
- **Deck cost figures are indicative estimates**, labelled as such — replace with real quotes before presenting.

## 10. Business context (for the deck, not the code)

Since Aug 2025: ₹5 L+ deployed, 5,000+ developer hours (founder + freelancers), ₹9 L external borrowing with a 10% return due 10 September — on track, funded via personal PF withdrawal. Live users including a small organic base in Europe. Patent filed, provisional phase. Scale ask ≈ ₹36–53 L over 12 months (Cloud GPU, currently unstable, plus one AI engineer).

Two claims deliberately **excluded** from all materials because they would fail technical review: the app cannot measure "ethanol contamination levels" (it disclaims being a lab test), and serpentine belt squeal is not a fuel-system symptom (the belt is not in the fuel path).
