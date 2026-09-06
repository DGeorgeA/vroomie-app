/**
 * rca_dedup_sweep.mjs — how much bucket coverage can Path A gain per unit of
 * false-positive risk?
 *
 * rca_full_bucket_coverage.mjs measured both sides of indexing all 44
 * power_steering recordings:
 *   coverage        0/44 -> 44/44   (the business objective)
 *   worst negative  153  -> 382     against a 480 sustained gate
 * That leaves 98 points of headroom on SPEECH. Healthy engine idle sits far
 * closer to a power-steering whine than speech does and is not testable here,
 * so 98 is not enough to ship on.
 *
 * The inflation is hash DENSITY, not coverage: 44 near-identical 1.5 s clips
 * of the same pump, each looped to 10 s, pile ~22 K hashes apiece into the same
 * region of hash space. Random audio then accumulates coincidental hits across
 * all of them. This is the effect the pre-ship review recorded when it raised
 * the worst healthy negative from 237 to 443.
 *
 * So: admit a candidate ONLY if it is acoustically distinct from what is
 * already indexed. Concretely — fingerprint the candidate, match it against
 * the partial index, and skip it when it already scores above a dedup
 * threshold. Coverage is preserved (a recording that already matches IS
 * already detected) while density is not.
 *
 * This sweeps the threshold so the trade can be chosen on evidence.
 *
 * Nothing is written.
 *
 * Usage: node scripts/rca_dedup_sweep.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  computeConstellationHashes,
  hydrateIndex,
  matchHashes,
  createRollingMatcher,
  SR,
  MIN_COHERENT_SCORE,
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
const asScan = (p) => p.length / SR < LISTEN_SECONDS * 2
  ? extendByCrossfadeLoop(p, LISTEN_SECONDS * 2, SR) : p;
const asRef = (p) => extendByCrossfadeLoop(p, TARGET_SECONDS, SR);

const b64ToInt32 = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const int32ToB64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/constellation_v1.json'), 'utf8'));
const psFiles = fs.readdirSync(AUDIO_DIR)
  .filter(f => f.startsWith('Issue_with_Power_steering')).sort();
const negatives = fs.readdirSync(AUDIO_DIR).filter(f => f.startsWith('Negative_'));
const faultFiles = [...new Set(shipped.refs.map(r => r.source_file))]
  .filter(f => fs.existsSync(path.join(AUDIO_DIR, f)));

// Pre-compute every fingerprint once — this dominates runtime.
console.log('fingerprinting candidates...');
const psRefFp = new Map();   // file -> {h,t} as the builder would index it
const psScan = new Map();    // file -> pcm as a live scan would see it
for (const f of psFiles) {
  const r = raw(f);
  psRefFp.set(f, computeConstellationHashes(asRef(r)));
  psScan.set(f, asScan(r));
}
const negScan = new Map(negatives.map(f => [f, asScan(raw(f))]));
const faultScan = new Map(faultFiles.map(f => [f, asScan(raw(f))]));

function buildIndex(admitted) {
  const pairs = [];
  const sK = b64ToInt32(shipped.keys), sV = b64ToInt32(shipped.vals);
  for (let i = 0; i < sK.length; i++) pairs.push([sK[i], sV[i]]);
  const refs = [...shipped.refs];
  for (const f of admitted) {
    const id = refs.length;
    const fp = psRefFp.get(f);
    for (let i = 0; i < fp.h.length; i++) pairs.push([fp.h[i], (id << 20) | (fp.t[i] & 0xfffff)]);
    refs.push({
      label: 'PowerSteeringPump', fault_type: 'power_steering',
      severity: 'high', source_file: f, hash_count: fp.h.length,
    });
  }
  pairs.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const K = new Int32Array(pairs.length), V = new Int32Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) { K[i] = pairs[i][0]; V[i] = pairs[i][1]; }
  return {
    ...shipped, refs, reference_count: refs.length,
    keys: int32ToB64(K), vals: int32ToB64(V), entry_count: pairs.length,
  };
}

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

/**
 * Greedy admission: walk candidates, admitting one only when it does NOT
 * already match the index built so far above `dedupScore`.
 */
function admitWithDedup(dedupScore) {
  const admitted = [];
  for (const f of psFiles) {
    hydrateIndex(buildIndex(admitted));
    const m = matchHashes(psRefFp.get(f));
    if (m.score >= dedupScore) continue;   // already covered
    admitted.push(f);
  }
  return admitted;
}

console.log(`\n══ Dedup threshold sweep — ${psFiles.length} power_steering candidates ══`);
console.log(`sustained gate ${SUSTAINED_COHERENT_SCORE}, instant gate ${MIN_COHERENT_SCORE}\n`);
console.log('dedup   admitted  entries    size     coverage   worstNeg  headroom  8-refs');

const RESULTS = [];
for (const dedup of [Infinity, 3000, 2000, 1200, 800, 600]) {
  const admitted = dedup === Infinity ? [...psFiles] : admitWithDedup(dedup);
  const idx = buildIndex(admitted);
  hydrateIndex(idx);

  const cov = psFiles.filter(f => scan(psScan.get(f)).fired).length;
  let worstNeg = 0, negFires = 0;
  for (const f of negatives) {
    const r = scan(negScan.get(f));
    if (r.peak.score > worstNeg) worstNeg = r.peak.score;
    if (r.fired) negFires++;
  }
  const keptAll = faultFiles.every(f => scan(faultScan.get(f)).fired);
  const bytes = JSON.stringify(idx).length;

  RESULTS.push({ dedup, admitted: admitted.length, cov, worstNeg, negFires, keptAll, bytes, entries: idx.entry_count });
  console.log(
    `${(dedup === Infinity ? 'none' : String(dedup)).padStart(5)}   `
    + `${String(admitted.length).padStart(8)}  ${String(idx.entry_count).padStart(8)}  `
    + `${(bytes / 1024 / 1024).toFixed(1).padStart(5)}MB  `
    + `${String(cov + '/' + psFiles.length).padStart(8)}   `
    + `${String(worstNeg).padStart(8)}  ${String(SUSTAINED_COHERENT_SCORE - worstNeg).padStart(8)}  `
    + `${keptAll ? 'ok' : 'REGRESSED'}${negFires ? `  ${negFires} NEG FIRED` : ''}`);
}

// Baseline for comparison.
hydrateIndex(shipped);
let baseWorst = 0;
for (const f of negatives) {
  const r = scan(negScan.get(f));
  if (r.peak.score > baseWorst) baseWorst = r.peak.score;
}
const baseCov = psFiles.filter(f => scan(psScan.get(f)).fired).length;
console.log(`\nshipped baseline: 0 admitted, coverage ${baseCov}/${psFiles.length}, `
  + `worstNeg ${baseWorst}, headroom ${SUSTAINED_COHERENT_SCORE - baseWorst}`);

console.log('\n── Reading the sweep ──');
console.log('A row is shippable only if it keeps the 8 existing references detecting,');
console.log('fires no negative, and leaves headroom comparable to the baseline. Coverage');
console.log('bought at the cost of headroom on SPEECH is a bad trade: healthy engine idle');
console.log('sits acoustically closer to a pump whine than speech does, and it is not');
console.log('testable in this container.');
