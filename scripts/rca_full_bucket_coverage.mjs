/**
 * rca_full_bucket_coverage.mjs — can Path A index EVERY suitable bucket
 * recording instead of one representative per family?
 *
 * THE BUSINESS OBJECTIVE says any fault sample stored in the anomaly-patterns
 * bucket should be detectable. Path A is an EXACT-RECORDING matcher: it
 * recognises the specific recordings in its index and nothing else. The
 * builder currently indexes ONE representative per family — the longest
 * broadband survivor — and leaves every other recording "to the embedding
 * path". Measured separately (rca_pathb_separability.mjs), the embedding path
 * only demonstrably generalises for power_steering, so "left to Path B" is
 * closer to "left uncovered" for most families.
 *
 * For 7 of the 9 families this costs nothing: they have exactly one recording,
 * so the representative IS the whole family. The gap is concentrated:
 *   power_steering            1 of 45 recordings indexed
 *   alternator_bearing_fault  1 of 3   (one of the other two is tonal, and
 *                                       correctly excluded by the flatness floor)
 *
 * WHY THIS MIGHT NOW BE SAFE WHEN IT WAS NOT BEFORE. The 44 unindexed
 * power_steering recordings are all 1.5 s. Two changes landed AFTER the review
 * that excluded them:
 *   1. length-corrected normalization (pre-ship review F2) — divide by the
 *      SMALLER of query and reference hash counts, so a reference shorter than
 *      the listen window is no longer structurally unable to reach threshold;
 *   2. extendByCrossfadeLoop — every reference is looped to TARGET_SECONDS
 *      before hashing, so a 1.5 s recording enters the index as 10 s.
 * The review's measurement ("PS_10 looped: 385/0.035 vs 400/0.05") predates
 * both. This harness re-measures rather than assuming either way.
 *
 * THE RISK IS FALSE POSITIVES, and it is not hypothetical: the same review
 * measured that dense near-duplicate hashes inflated the worst healthy
 * negative from 237 to 443. So this reports BOTH sides — self-match rate AND
 * what happens to every negative — and treats the negative side as the veto.
 *
 * Nothing is written. The shipped artifact is not touched.
 *
 * Usage: node scripts/rca_full_bucket_coverage.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  computeConstellationHashes,
  hydrateIndex,
  createRollingMatcher,
  SR,
  MIN_COHERENT_SCORE,
  MIN_NORMALIZED_SCORE,
  SUSTAINED_COHERENT_SCORE,
  LISTEN_SECONDS,
} from '../src/lib/constellationMatcher.js';
import { extendByCrossfadeLoop, TARGET_SECONDS } from './lib/extendLoop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUDIO_DIR = path.join(ROOT, 'scripts/tmp_audio');

function decodeWav(buf) {
  let i = 12, channels = 1, rate = SR, bits = 16, fmtTag = 1, data = null;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ') {
      fmtTag = buf.readUInt16LE(i + 8); channels = buf.readUInt16LE(i + 10);
      rate = buf.readUInt32LE(i + 12); bits = buf.readUInt16LE(i + 22);
    } else if (id === 'data') { data = buf.subarray(i + 8, i + 8 + size); break; }
    i += 8 + size + (size % 2);
  }
  if (!data) throw new Error('no data chunk');
  const bytes = bits / 8, frames = Math.floor(data.length / bytes / channels);
  const mono = new Float32Array(frames);
  const read = (off) => {
    if (bits === 16) return data.readInt16LE(off) / 32768;
    if (bits === 32 && fmtTag === 3) return data.readFloatLE(off);
    if (bits === 32) return data.readInt32LE(off) / 2147483648;
    if (bits === 8) return (data.readUInt8(off) - 128) / 128;
    throw new Error(`unsupported wav (bits=${bits} fmt=${fmtTag})`);
  };
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += read((f * channels + c) * bytes);
    mono[f] = acc / channels;
  }
  return { pcm: mono, rate };
}

function to16k(pcm, rate) {
  if (rate === SR) return pcm;
  const ratio = rate / SR, outLen = Math.max(1, Math.floor(pcm.length / ratio));
  const out = new Float32Array(outLen), maxIdx = pcm.length - 1;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio, l = Math.min(maxIdx, Math.floor(x)), r = Math.min(maxIdx, l + 1);
    out[i] = pcm[l] * (1 - (x - l)) + pcm[r] * (x - l);
  }
  return out;
}

const raw = (f) => {
  const { pcm, rate } = decodeWav(fs.readFileSync(path.join(AUDIO_DIR, f)));
  return to16k(pcm, rate);
};
/** As the LIVE scan would see it: continuous audio of at least the listen window. */
const asScan = (pcm) => pcm.length / SR < LISTEN_SECONDS * 2
  ? extendByCrossfadeLoop(pcm, LISTEN_SECONDS * 2, SR) : pcm;
/** As the BUILDER would index it. */
const asRef = (pcm) => extendByCrossfadeLoop(pcm, TARGET_SECONDS, SR);

const b64ToInt32 = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const int32ToB64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/constellation_v1.json'), 'utf8'));

// ── Build the CANDIDATE index: shipped 8 + every local power_steering file ──
const psFiles = fs.readdirSync(AUDIO_DIR)
  .filter(f => f.startsWith('Issue_with_Power_steering')).sort();

const pairs = [];
const sK = b64ToInt32(shipped.keys), sV = b64ToInt32(shipped.vals);
for (let i = 0; i < sK.length; i++) pairs.push([sK[i], sV[i]]);

const addedRefs = [];
for (const f of psFiles) {
  const id = shipped.refs.length + addedRefs.length;
  if (id > 4095) { console.warn('refId overflow'); break; }
  const fp = computeConstellationHashes(asRef(raw(f)));
  for (let i = 0; i < fp.h.length; i++) pairs.push([fp.h[i], (id << 20) | (fp.t[i] & 0xfffff)]);
  addedRefs.push({
    label: 'PowerSteeringPump', fault_type: 'power_steering',
    severity: 'high', source_file: f, hash_count: fp.h.length,
  });
}
pairs.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
const K = new Int32Array(pairs.length), V = new Int32Array(pairs.length);
for (let i = 0; i < pairs.length; i++) { K[i] = pairs[i][0]; V[i] = pairs[i][1]; }

const candidate = {
  ...shipped,
  refs: [...shipped.refs, ...addedRefs],
  reference_count: shipped.refs.length + addedRefs.length,
  keys: int32ToB64(K), vals: int32ToB64(V), entry_count: pairs.length,
};

const shippedBytes = JSON.stringify(shipped).length;
const candBytes = JSON.stringify(candidate).length;

console.log('══ Full-bucket Path A coverage — CANDIDATE index, nothing written ══\n');
console.log(`shipped:   ${shipped.refs.length} refs, ${shipped.entry_count} entries, ${(shippedBytes / 1024).toFixed(0)} KB`);
console.log(`candidate: ${candidate.refs.length} refs, ${candidate.entry_count} entries, ${(candBytes / 1024).toFixed(0)} KB`);
console.log(`added:     ${addedRefs.length} power_steering recordings (all 1.5 s native, looped to ${TARGET_SECONDS}s)`);
console.log(`Gates: instant >=${MIN_COHERENT_SCORE}/${MIN_NORMALIZED_SCORE}, sustained >=${SUSTAINED_COHERENT_SCORE}\n`);

/** Run one clip through the rolling matcher at the production cadence. */
function scan(pcm) {
  const m = createRollingMatcher();
  const BLOCK = 4096, TRY = Math.round(SR * 0.9);
  let since = 0, peak = { score: 0, normalized: 0, ref: null }, fired = null;
  for (let off = 0; off + BLOCK <= pcm.length; off += BLOCK) {
    m.push(pcm.subarray(off, off + BLOCK));
    since += BLOCK;
    if (since < TRY) continue;
    since = 0;
    const r = m.tryMatch();
    if (!r) continue;
    if (r.score > peak.score) peak = r;
    if (r.matched && !fired) fired = r;
  }
  return { peak, fired };
}

const negatives = fs.readdirSync(AUDIO_DIR).filter(f => f.startsWith('Negative_'));
const faultFiles = [...new Set(shipped.refs.map(r => r.source_file))]
  .filter(f => fs.existsSync(path.join(AUDIO_DIR, f)));

// ── BEFORE: shipped index ───────────────────────────────────────────────────
hydrateIndex(shipped);
const before = { neg: [], ps: [], fault: [] };
for (const f of negatives) before.neg.push({ f, ...scan(asScan(raw(f))) });
for (const f of psFiles) before.ps.push({ f, ...scan(asScan(raw(f))) });
for (const f of faultFiles) before.fault.push({ f, ...scan(asScan(raw(f))) });

// ── AFTER: candidate index ──────────────────────────────────────────────────
hydrateIndex(candidate);
const after = { neg: [], ps: [], fault: [] };
for (const f of negatives) after.neg.push({ f, ...scan(asScan(raw(f))) });
for (const f of psFiles) after.ps.push({ f, ...scan(asScan(raw(f))) });
for (const f of faultFiles) after.fault.push({ f, ...scan(asScan(raw(f))) });

const worst = (rows) => rows.reduce((m, r) => r.peak.score > m.peak.score ? r : m, rows[0]);
const fires = (rows) => rows.filter(r => r.fired).length;

console.log('── SAFETY: negatives (the veto) ──');
console.log('file                              before          after');
let regressed = 0;
for (let i = 0; i < negatives.length; i++) {
  const b = before.neg[i], a = after.neg[i];
  const delta = a.peak.score - b.peak.score;
  if (a.fired) regressed++;
  console.log(`${b.f.slice(0, 32).padEnd(33)} ${String(b.peak.score).padStart(5)} ${(b.fired ? 'FIRE' : '    ')}   `
    + `${String(a.peak.score).padStart(5)} ${(a.fired ? 'FIRE' : '    ')}  ${delta >= 0 ? '+' : ''}${delta}`);
}
const wb = worst(before.neg), wa = worst(after.neg);
console.log(`\nworst negative  before ${wb.peak.score} (${wb.f})`);
console.log(`                after  ${wa.peak.score} (${wa.f})`);
console.log(`headroom to the sustained gate: before ${SUSTAINED_COHERENT_SCORE - wb.peak.score}, after ${SUSTAINED_COHERENT_SCORE - wa.peak.score}`);
console.log(`negatives that FIRED: before ${fires(before.neg)}, after ${fires(after.neg)}`);

console.log('\n── COVERAGE: the 44 power_steering bucket recordings ──');
console.log(`detected before: ${fires(before.ps)} / ${psFiles.length}`);
console.log(`detected after:  ${fires(after.ps)} / ${psFiles.length}`);
{
  const missed = after.ps.filter(r => !r.fired);
  if (missed.length) {
    console.log(`still missed (${missed.length}):`);
    for (const m of missed.slice(0, 8)) {
      console.log(`  ${m.f.slice(0, 44).padEnd(45)} peak ${m.peak.score} / ${(m.peak.normalized || 0).toFixed(4)}`);
    }
  }
  const wrongFamily = after.ps.filter(r => r.fired && r.fired.ref?.fault_type !== 'power_steering');
  console.log(`fired as the WRONG family: ${wrongFamily.length}`);
}

console.log('\n── NO REGRESSION: the 8 shipped references still detect ──');
for (let i = 0; i < faultFiles.length; i++) {
  const b = before.fault[i], a = after.fault[i];
  const ok = a.fired && a.fired.ref?.fault_type === b.fired?.ref?.fault_type;
  console.log(`${b.f.slice(0, 32).padEnd(33)} before ${(b.fired ? 'YES' : 'no ')} ${String(b.peak.score).padStart(5)}   `
    + `after ${(a.fired ? 'YES' : 'no ')} ${String(a.peak.score).padStart(5)}  ${ok ? 'ok' : 'CHANGED'}`);
}

console.log('\n── Verdict ──');
const safe = fires(after.neg) === 0;
const gained = fires(after.ps) - fires(before.ps);
const kept = after.fault.every((a, i) => !before.fault[i].fired || a.fired);
console.log(`negatives still clean:      ${safe ? 'YES' : 'NO — VETO'}`);
console.log(`bucket coverage gained:     +${gained} recordings`);
console.log(`existing detections kept:   ${kept ? 'YES' : 'NO — REGRESSION'}`);
console.log(`artifact size:              ${(shippedBytes / 1024).toFixed(0)} KB -> ${(candBytes / 1024).toFixed(0)} KB`);
console.log(`\n${safe && kept && gained > 0 ? 'PROCEED — safe and strictly better' : 'DO NOT SHIP as-is'}`);
