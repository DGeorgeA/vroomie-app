# Path B reference-set diversity gap

**Status:** measured, unresolved. No code or artifact change accompanies this
document — it exists so the collection work can be prioritised against numbers
rather than impressions.

**Reproduce:** `node scripts/rca_pathb_separability.mjs`

---

## The finding in one line

Path B has **352 fault embeddings drawn from only 53 distinct recordings**, and
**7 of the 9 fault families rest on a single recording each**. Only
`power_steering` has enough source diversity to demonstrate that it generalises
to audio it has never heard.

## The measurement

Each fault reference is treated as if it were a live window and scored against
the index under the production rules (`bestScore >= 0.45`, `margin >= 0.04`,
where `margin = bestScore - bestHealthyAnchorScore`). Two views are reported:

- **CEILING** — the probe is present in the index. Maximally easy: identical
  recording conditions, no microphone channel, no room. This is an upper bound
  nothing in the field can exceed.
- **HELD OUT** — the probe's own source recording is removed from the index
  first. This is the field condition, because live audio is never itself a
  reference. It is only defined for families with more than one recording.

```
                            ┌── CEILING: probe in index ──┐  ┌── HELD OUT ────────────────┐
family                      refs src  accept%  correct%  margin   accept%  correct%  margin  verdict
*alternator_bearing_fault    100   3      94%       99%   0.135       30%        3%   0.021  weak
*misfire_detected_medium      24   1     100%      100%   0.251       n/a       n/a     n/a  UNPROVEN
*motor_starter                 8   1     100%       88%   0.164       n/a       n/a     n/a  UNPROVEN
*piston_knock                 24   1     100%      100%   0.123       n/a       n/a     n/a  UNPROVEN
 intake_leak                  24   1     100%      100%   0.186       n/a       n/a     n/a  UNPROVEN
 power_steering              100  45      92%       97%   0.142       73%       82%   0.093  generalises
 rocker_valve                 24   1      92%       86%   0.141       n/a       n/a     n/a  UNPROVEN
 serpentine_belt              24   1     100%       96%   0.344       n/a       n/a     n/a  UNPROVEN
 timing_chain                 24   1     100%      100%   0.390       n/a       n/a     n/a  UNPROVEN
```

`*` = family reported as not identified in the field.
`refs` = embeddings. `src` = distinct source recordings.

## How to read it

**The ceiling column is not evidence of anything.** Every family scores 92-100%
there, including the families that fail in the field. That is what a ceiling
measured on its own training data looks like, and it is why the ceiling alone
should never be quoted as accuracy.

**The held-out column is the one that matters, and it is mostly blank.** A
family with one recording cannot be held out — remove that recording and there
is nothing of the family left in the index. So `n/a` here means *untested*, not
*passing*. Seven families are in that state.

**Where the two views can be compared, they diverge sharply.**
`alternator_bearing_fault` has 3 recordings. At the ceiling it is 99% correct
with a 0.135 margin. Held out it collapses to 3% correct with a **0.021 margin
against a 0.040 gate** — roughly half of what it needs. This is direct evidence
that its 100 embeddings are 3 recordings wearing 100 costumes: augmentation
multiplies the row count without adding acoustic variety.

**`power_steering` is the control that proves the method works.** With 45
distinct recordings it holds up held-out: 73% accepted, 82% correct, margin
0.093 — more than double the gate. Nothing about Path B's design is broken. The
reference set is simply too thin everywhere else.

## Why this surfaced now

While Path A was armed in both tiers, the fingerprint fast path covered
`alternator_bearing_fault`, `motor_starter` and `piston_knock` before Path B's
weakness could show. Disarming Path A for AI Enabled removed that cover and
exposed the gap. Path A has since been re-armed in both tiers, so the symptom is
addressed — but the underlying thinness is unchanged, and it still bounds:

- every family Path A does **not** index (`misfire_detected_medium` is the live
  example — Path B is its only path in either tier);
- any future fault family, which will arrive Path-B-only;
- Path C promotion, which is calibrated against the same anchors.

## What each family needs

The working target is **`power_steering`'s diversity, not its embedding count**:
~45 distinct recordings, spanning different vehicles, microphones and ambient
conditions. Augmenting one recording into 24 rows does not approach it — the
alternator result above is the measurement that says so.

Priority order, by exposure:

| Priority | Family | Now | Why first |
|---|---|---|---|
| 1 | `misfire_detected_medium` | 1 rec | Path B is its **only** path in either tier — excluded from Path A because it false-fired on healthy idle |
| 2 | `motor_starter` | 1 rec, 8 embeds | Thinnest family in the index by both measures |
| 3 | `piston_knock` | 1 rec | Reported by the user; Path A covers it, Path B does not corroborate |
| 4 | `alternator_bearing_fault` | 3 recs | Only family with *measured* held-out failure (0.021 vs 0.040) |
| 5 | `intake_leak`, `rocker_valve`, `serpentine_belt`, `timing_chain` | 1 rec each | Not yet reported, same structural risk |

## Suggested acceptance bar

Before a family is described as detected by Path B:

1. At least 8 distinct source recordings, from more than one vehicle.
2. Held-out accept rate ≥ 70% and held-out correct rate ≥ 80%
   (`power_steering` currently sets that bar at 73% / 82%).
3. Held-out margin ≥ 0.08, i.e. twice `ANCHOR_MARGIN`, so the field channel has
   somewhere to erode.
4. No regression in the healthy false-fire sweep.

## Open blocker

The bucket (`anomaly-patterns`) is outside this container's network allowlist,
so new recordings cannot be ingested or measured from here. The rebuild and the
re-measurement have to run somewhere with bucket access.

Related and blocked by the same thing: `scripts/rca_misfire_pathA_retest.mjs`
shows misfire adding no collision among the locally available negatives
(worst negative 153 against a 480 sustained gate), but the negatives that
actually drove its exclusion — healthy engine idle — live in that bucket and did
not run. Misfire therefore stays excluded from Path A.
