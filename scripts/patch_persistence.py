"""
Recalibrate the fingerprint decision using REAL DEVICE data.

Field telemetry (2026-08-13, build v10.3, user's phone through a speaker):
  Alternator played -> identified "Alternator bearing noise" score 496/503/514/542
  Piston played     -> identified "Piston"                    score 494
  Intake leak       -> identified "Intake leak"               score 553
The LABEL was correct every time; only my threshold (600) rejected them. That
600 came from a SIMULATED channel where positives scored 621+. Real phone
capture through a real speaker lands near 500.

Rather than simply lowering the bar toward the worst measured negative (a
healthy brakes clip at 443), add PERSISTENCE — the same discriminator that
already protects the embedding path. A genuine replay yields the SAME reference
on consecutive attempts a second apart; a coincidental peak alignment on a
healthy engine does not hold its identity.

  instant  : score >= 600 AND norm >= 0.050            (unchanged, one shot)
  sustained: score >= 470 AND norm >= 0.042, and the SAME reference wins
             2 consecutive attempts (~0.9 s apart)
"""
import io

P = "src/lib/constellationMatcher.js"
s = io.open(P, encoding="utf-8").read()

old = """export const MIN_COHERENT_SCORE = 600;
export const MIN_NORMALIZED_SCORE = 0.05;"""
new = """export const MIN_COHERENT_SCORE = 600;
export const MIN_NORMALIZED_SCORE = 0.05;
// Sustained tier — real-device calibration. Field telemetry showed correct
// identifications scoring 494-553 (alternator 496/503/514/542, piston 494),
// i.e. genuine matches sitting just under a threshold derived from simulated
// audio. Instead of dropping the bar to the worst negative (443, a healthy
// brakes clip), a lower bar is paired with PERSISTENCE: the same reference must
// win two consecutive attempts ~0.9 s apart. Random peak alignment does not
// keep its identity across independent windows; a real replay does.
export const SUSTAINED_COHERENT_SCORE = 470;
export const SUSTAINED_NORMALIZED_SCORE = 0.042;
export const SUSTAINED_REPEATS = 2;"""
assert s.count(old) == 1
s = s.replace(old, new)

old_rm = """export function createRollingMatcher() {
  const cap = SR * LISTEN_SECONDS;
  const buf = new Float32Array(cap);
  let filled = 0, write = 0, totalFed = 0;
  return {
    push(chunk) {
      totalFed += chunk.length;
      for (let i = 0; i < chunk.length; i++) {
        buf[write] = chunk[i];
        write = (write + 1) % cap;
      }
      filled = Math.min(filled + chunk.length, cap);
    },
    secondsBuffered: () => filled / SR,
    /** Null until enough audio has accumulated or the index is unavailable. */
    tryMatch() {
      if (!index || filled < SR * MIN_LISTEN_SECONDS) return null;
      // linearise the ring buffer oldest-first
      const lin = new Float32Array(filled);
      const start = (write - filled + cap) % cap;
      for (let i = 0; i < filled; i++) lin[i] = buf[(start + i) % cap];
      return matchHashes(computeConstellationHashes(lin));
    },
    reset() { filled = 0; write = 0; totalFed = 0; },
  };
}"""
new_rm = """export function createRollingMatcher() {
  const cap = SR * LISTEN_SECONDS;
  const buf = new Float32Array(cap);
  let filled = 0, write = 0, totalFed = 0;
  // Persistence state for the sustained tier.
  let lastRef = null, streak = 0;
  return {
    push(chunk) {
      totalFed += chunk.length;
      for (let i = 0; i < chunk.length; i++) {
        buf[write] = chunk[i];
        write = (write + 1) % cap;
      }
      filled = Math.min(filled + chunk.length, cap);
    },
    secondsBuffered: () => filled / SR,
    /** Null until enough audio has accumulated or the index is unavailable. */
    tryMatch() {
      if (!index || filled < SR * MIN_LISTEN_SECONDS) return null;
      // linearise the ring buffer oldest-first
      const lin = new Float32Array(filled);
      const start = (write - filled + cap) % cap;
      for (let i = 0; i < filled; i++) lin[i] = buf[(start + i) % cap];
      const m = matchHashes(computeConstellationHashes(lin));

      // ── sustained tier: lower bar, but identity must persist ────────────
      const refKey = m.ref ? m.ref.source_file : null;
      const qualifies = !!m.ref &&
        m.score >= SUSTAINED_COHERENT_SCORE &&
        m.normalized >= SUSTAINED_NORMALIZED_SCORE;
      if (qualifies && refKey === lastRef) {
        streak += 1;
      } else if (qualifies) {
        lastRef = refKey;
        streak = 1;
      } else {
        lastRef = null;
        streak = 0;
      }
      m.streak = streak;
      m.sustained = qualifies && streak >= SUSTAINED_REPEATS;
      // `matched` stays the union: an instant strong hit, or a sustained one.
      m.matched = m.matched || m.sustained;
      return m;
    },
    reset() { filled = 0; write = 0; totalFed = 0; lastRef = null; streak = 0; },
  };
}"""
assert s.count(old_rm) == 1
s = s.replace(old_rm, new_rm)
io.open(P, "w", encoding="utf-8", newline="").write(s)
print("persistence tier added")
