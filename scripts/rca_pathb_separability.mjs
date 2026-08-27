/**
 * rca_pathb_separability.mjs — can PATH B ALONE carry the four reported
 * families? AI Enabled no longer arms Path A, so Path B is all it has.
 *
 * YAMNet cannot run in this container (not cached; TF Hub is outside the
 * network allowlist), so live audio cannot be embedded here. What CAN be
 * measured exactly is the geometry of the shipped index itself: every fault
 * reference is a real 1024-d YAMNet embedding of real audio.
 *
 * LEAVE-ONE-OUT: treat each reference as if it were a live window. Score it
 * against every OTHER reference and against all 94 anchors, then apply the
 * production rules (bestScore >= ANOMALY_THRESHOLD, margin >= ANCHOR_MARGIN).
 * This is the most favourable case Path B will ever see — identical recording
 * conditions, no microphone channel, no room. If a family cannot clear its own
 * gates here, it certainly cannot clear them from a phone in a car park.
 *
 * Usage: node scripts/rca_pathb_separability.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Production constants, mirrored from mlEmbeddingEngine.js.
const ANOMALY_THRESHOLD = 0.45;
const ANCHOR_MARGIN = 0.04;
const NEAR_ANCHOR_MARGIN = 0.02;

const REPORTED = new Set([
  'alternator_bearing_fault', 'motor_starter', 'piston_knock', 'misfire_detected_medium',
]);

const fp = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/fingerprints_v9.json'), 'utf8'));

/** Dequantize an int8 payload back to a unit-normalised Float32 embedding. */
function dequant(q, dim) {
  const bin = Buffer.from(q.b64, 'base64');
  const v = new Float32Array(dim);
  let ss = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = q.min + bin[i] * q.scale;
    ss += v[i] * v[i];
  }
  const n = Math.sqrt(ss) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

const dim = fp.dim;
const faults = fp.faults.map(f => ({ ...f, v: dequant(f.q, dim) }));
const anchors = fp.anchors.map(a => ({ ...a, v: dequant(a.q, dim) }));

const cos = (a, b) => { let s = 0; for (let i = 0; i < dim; i++) s += a[i] * b[i]; return s; };

console.log('══ PATH B leave-one-out separability ══');
console.log(`${faults.length} fault refs, ${anchors.length} anchors, dim ${dim}`);
console.log(`Gates: bestScore >= ${ANOMALY_THRESHOLD}, margin >= ${ANCHOR_MARGIN} `
  + `(NEAR band from ${NEAR_ANCHOR_MARGIN})\n`);

const byFamily = new Map();

for (let i = 0; i < faults.length; i++) {
  const probe = faults[i];

  // PRODUCTION-EQUIVALENT scoring: live audio is compared against EVERY fault
  // reference, so the only exclusion is the probe itself. This is the CEILING
  // for Path B — the probe is a member of the index, so an in-family match is
  // maximally easy. If a family cannot clear its gates even here, it cannot
  // clear them in the field.
  //
  // (An earlier version of this harness also excluded the probe's own source
  // file, to test generalisation. That reads as 0% correct for every family
  // with one recording — which is 7 of the 9 — so it measures the reference
  // set's lack of diversity, not the engine. The diversity finding is reported
  // separately below; the gate maths here uses production rules.)
  let best = null, bestScore = -1;
  for (let j = 0; j < faults.length; j++) {
    if (j === i) continue;
    const s = cos(probe.v, faults[j].v);
    if (s > bestScore) { bestScore = s; best = faults[j]; }
  }
  if (!best) continue;

  let bestAnchor = -1;
  for (const a of anchors) {
    const s = cos(probe.v, a.v);
    if (s > bestAnchor) bestAnchor = s;
  }

  // HELD-OUT view: the same probe, but with its own source recording removed
  // from the index. This is the field condition — live audio is never itself a
  // reference. Only meaningful for families with >1 distinct recording; for the
  // rest it is recorded as undefined rather than reported as a failure.
  let heldBest = null, heldScore = -1;
  for (let j = 0; j < faults.length; j++) {
    if (faults[j].source_file === probe.source_file) continue;
    const s = cos(probe.v, faults[j].v);
    if (s > heldScore) { heldScore = s; heldBest = faults[j]; }
  }
  const heldMargin = heldBest ? heldScore - bestAnchor : null;

  const margin = bestScore - bestAnchor;
  const passesThreshold = bestScore >= ANOMALY_THRESHOLD;
  const passesMargin = margin >= ANCHOR_MARGIN;
  const correct = best.fault_type === probe.fault_type;

  const key = probe.fault_type;
  if (!byFamily.has(key)) {
    byFamily.set(key, {
      n: 0, accepted: 0, correct: 0, near: 0,
      belowThreshold: 0, belowMargin: 0,
      sumScore: 0, sumAnchor: 0, sumMargin: 0,
      sources: new Set(), confusedWith: new Map(),
      heldN: 0, heldAccepted: 0, heldCorrect: 0, heldSumMargin: 0,
    });
  }
  const g = byFamily.get(key);
  g.n++;
  if (heldBest && heldMargin !== null) {
    g.heldN++;
    g.heldSumMargin += heldMargin;
    if (heldScore >= ANOMALY_THRESHOLD && heldMargin >= ANCHOR_MARGIN) {
      g.heldAccepted++;
      if (heldBest.fault_type === probe.fault_type) g.heldCorrect++;
    }
  }
  g.sources.add(probe.source_file);
  g.sumScore += bestScore;
  g.sumAnchor += bestAnchor;
  g.sumMargin += margin;
  if (!passesThreshold) g.belowThreshold++;
  else if (!passesMargin) {
    g.belowMargin++;
    if (margin >= NEAR_ANCHOR_MARGIN) g.near++;
  } else {
    g.accepted++;
    if (correct) g.correct++;
    else g.confusedWith.set(best.fault_type, (g.confusedWith.get(best.fault_type) || 0) + 1);
  }
}

const order = [...byFamily.entries()].sort((a, b) => {
  const ra = REPORTED.has(a[0]) ? 0 : 1, rb = REPORTED.has(b[0]) ? 0 : 1;
  return ra - rb || a[0].localeCompare(b[0]);
});

console.log('                            ┌── CEILING: probe is in the index ──┐  ┌── HELD OUT: own recording removed ─┐');
console.log('family                      refs src  accept%  correct%  avgMargin   accept%  correct%  avgMargin  verdict');
for (const [fam, g] of order) {
  const acc = (100 * g.accepted / g.n);
  const cor = g.accepted ? (100 * g.correct / g.accepted) : 0;
  const flag = REPORTED.has(fam) ? '*' : ' ';
  const hasHeld = g.sources.size > 1 && g.heldN > 0;
  const hAcc = hasHeld ? `${(100 * g.heldAccepted / g.heldN).toFixed(0)}%`.padStart(8) : '     n/a';
  const hCor = hasHeld ? `${g.heldAccepted ? (100 * g.heldCorrect / g.heldAccepted).toFixed(0) : 0}%`.padStart(9) : '      n/a';
  const hMrg = hasHeld ? (g.heldSumMargin / g.heldN).toFixed(3).padStart(10) : '       n/a';
  const verdict = !hasHeld ? 'UNPROVEN — single recording'
    : (100 * g.heldCorrect / Math.max(1, g.heldN)) >= 50 ? 'generalises' : 'weak';
  console.log(
    `${flag}${fam.padEnd(26)} ${String(g.n).padStart(4)} ${String(g.sources.size).padStart(3)} `
    + `${acc.toFixed(0).padStart(7)}% ${cor.toFixed(0).padStart(8)}% `
    + `${(g.sumMargin / g.n).toFixed(3).padStart(10)}  ${hAcc} ${hCor} ${hMrg}  ${verdict}`);
}

console.log('\n* = family the user reported as not identified\n');
console.log('── Confusions among accepted windows ──');
for (const [fam, g] of order) {
  if (!g.confusedWith.size) continue;
  const parts = [...g.confusedWith.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} x${v}`).join(', ');
  console.log(`${fam.padEnd(27)} -> ${parts}`);
}

console.log('\n── Single-source families (leave-one-out is undefined) ──');
for (const [fam, g] of order) {
  if (g.sources.size <= 1) console.log(`${fam.padEnd(27)} only ${g.sources.size} distinct recording(s)`);
}
const covered = new Set(byFamily.keys());
for (const f of faults) {
  if (!covered.has(f.fault_type)) {
    const srcs = new Set(faults.filter(x => x.fault_type === f.fault_type).map(x => x.source_file));
    if (srcs.size <= 1) {
      console.log(`${f.fault_type.padEnd(27)} EXCLUDED ENTIRELY — all ${srcs.size} source(s) identical`);
      covered.add(f.fault_type);
    }
  }
}
