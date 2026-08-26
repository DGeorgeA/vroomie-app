# Vroomie — How It Works, and Why It Can Be Trusted

**A plain-English overview of the diagnostic engine, for investors and non-technical reviewers.**

---

## 1. What Vroomie does

A driver opens the app, points their phone at the engine, and within seconds is told whether it sounds healthy — and if not, what the likely fault is, in plain language, with a report they can hand to a workshop.

No sensors. No OBD dongle. No garage visit. **Just the phone already in their pocket.**

## 2. The problem nobody had solved

Anyone can build something that "listens and guesses". The hard part is being *trustworthy in both directions*:

- Tell a driver their healthy car is broken → they lose trust and stop using it
- Miss a real fault → the product is worthless

Most naive approaches fail the first test badly. Vroomie's earliest version did too: it would hear a television, or silence, and confidently report a power-steering fault. **That failure is what shaped the architecture.**

## 3. The core idea that fixed it

The breakthrough was changing the question the software asks.

| | The question | Result |
|---|---|---|
| **Naive approach** | *"Which fault does this sound most like?"* | Always returns a fault — even for silence. Everything looks like something. |
| **Vroomie** | *"Is this closer to a known fault than to a **healthy engine**?"* | Can answer "nothing wrong" — because it holds healthy engines as reference points too. |

Vroomie stores fingerprints of **healthy** engines alongside faulty ones. A sound is only reported as a fault when it is measurably closer to a fault than to any healthy engine or background noise. This single change is why the system can stay quiet.

## 4. Two listening systems, deliberately different

Vroomie runs two independent matchers. They have opposite strengths, which is precisely why both exist.

```
                    Phone microphone
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
   FAST IDENTIFIER                   PATTERN MATCHER
   (Shazam-style)                    (AI sound model)

   "I know this exact               "This sounds like the
    recording"                       family of sounds a
                                     failing bearing makes"

   ~3 seconds                       Full recording session
   Certainty: very high             Confidence: 65–97%
   Works on: known                  Works on: any vehicle
   reference recordings              with a supported fault
```

**The fast identifier** uses the same principle as Shazam. It reduces sound to a constellation of distinctive peaks and checks whether they line up *in time* with a known recording. Random noise cannot fake that alignment — which is why it can be made sensitive without becoming trigger-happy.

**The pattern matcher** is the general-purpose engine. It uses a Google-trained audio AI model (YAMNet) to understand what kind of sound it is hearing, then compares its acoustic signature against Vroomie's fault library.

**Why two?** The fast identifier is certain but narrow — like recognising a song. The pattern matcher generalises to any car but is less certain. Together they cover both demonstration reliability and real-world breadth.

## 5. Four safety gates before anything is reported

A sound must survive every one of these before a driver is told anything:

1. **Is it loud enough?** — silence is discarded
2. **Is it a vehicle at all?** — speech, TV, music and street noise are filtered out here
3. **Is it more fault-like than healthy-like?** — the core comparison from §3
4. **Did it persist?** — a fault must dominate the recording, not appear in one stray moment

A single suspicious instant never produces a diagnosis. This is why the system is quiet around ordinary household sound.

## 6. Confidence is honest, and graded

Vroomie never says "your car is broken". It says how confident it is, and the levels are meaningful:

| Confidence | What it means | How it is reached |
|---|---|---|
| **97%** | Identified with near-certainty | Fast identifier matched a known recording |
| **70–97%** | Confirmed fault pattern | Sustained across the session, clearly fault-like |
| **65–69%** | *Possible* — verification required | Consistent but weaker signal; explicitly flagged as needing a workshop check |
| Nothing reported | No reliable signal | The system stays silent rather than guess |

The 65–69% tier was added only after measuring that it produced **zero additional false alarms** across 140 healthy-vehicle recordings.

## 7. How we know it works — measured, not claimed

Every figure below comes from an automated test suite that runs against recordings **the system has never seen during development**.

| Measure | Result |
|---|---|
| Reference recordings correctly identified through a speaker | **42 / 42** across five capture conditions |
| Misidentifications (naming the wrong fault) | **0** |
| Speech, TV, music, fan, traffic, silence falsely flagged | **0** |
| Healthy vehicles falsely alarmed | **6 of 140 (4.3%)** |
| Real unseen faults detected | **~2 in 3** |
| Time to identify a known recording | **~3 seconds** |

**We publish the weaknesses too.** The 4.3% false-alarm rate and the two-in-three detection rate are both limited by the size of today's reference library — not by the algorithm. Both improve directly as real-world recordings are added, with no code changes required.

## 8. Why this is defensible

- **The data asset compounds.** Every real fault recording collected makes detection better for every future user. Competitors starting today start from zero.
- **The engineering discipline is the moat.** The architecture is the product of repeatedly finding and fixing subtle failures — dataset imbalance, speaker distortion, false-confidence traps. Each fix is documented with the measurement that justified it.
- **It runs entirely on the phone.** No per-diagnosis server cost. Analysis happens locally; margins scale cleanly with users.
- **Failures are visible.** Every session — including failed ones — records why it failed, so problems are diagnosed from data instead of guesswork.

## 9. Honest limitations

We would rather state these plainly than have them discovered later:

- The fast identifier recognises **specific recordings**, not any car with that fault — exactly like Shazam identifying a track but not a cover version. Real-world coverage rests on the pattern matcher.
- Detection currently covers **nine fault families**. Some common faults have no reference audio yet and cannot be detected at all.
- Roughly **1 in 23 healthy vehicles** may see a low-confidence alert. Real-world reference data is the fix.
- Every acoustic figure above is measured through simulated speaker-and-room conditions plus in-app testing; large-scale field validation across many phone models is the next milestone.

## 10. Where the next investment goes

**Real fault recordings, captured on phones, from real vehicles.** Not algorithm work — the algorithm is measured and sound. The reference library is the binding constraint on both accuracy numbers in §7, and the infrastructure to ingest new recordings is already built and automated.

---

*Every claim in this document is reproducible from the automated test suites in this repository. Technical detail: `VROOMIE_DETECTION_ARCHITECTURE_V10.md` and `VROOMIE_ARCHITECTURE_HANDOVER.md`.*
