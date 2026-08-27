/**
 * rca_misfire_pathA_retest.mjs — can misfire safely rejoin the Path A index?
 *
 * Misfire is the one reported family with NO fingerprint coverage in either
 * tier. It was excluded deliberately: acoustically it is an IRREGULAR IDLE, so
 * its fingerprint collides with rough-but-healthy idling engines, and it
 * produced the only two healthy false fires ever measured — scores 496-523,
 * SUSTAINED across 4 consecutive attempts, so the persistence rule could not
 * separate them either. See EXCLUDED in build_constellation_index.mjs.
 *
 * This harness builds a CANDIDATE index (shipped 8 refs + misfire) in memory
 * and re-runs the negatives against it. Nothing is written; the shipped
 * artifact is not touched.
 *
 * ── WHAT THIS CAN AND CANNOT SETTLE ────────────────────────────────────────
 * The exclusion was driven by HEALTHY ENGINE IDLE audio. That audio lives in
 * the anomaly-patterns bucket, which is outside this container's network
 * allowlist, so the decisive negatives CANNOT be run here. What runs here is
 * the locally available negative set (silence, noise, speech, TV, radio,
 * babble) plus every non-misfire fault reference as a cross-family negative.
 *
 * A clean run therefore means "no NEW collision among the negatives we have",
 * NOT "safe to ship". Treat a clean result as a precondition, not a verdict.
 *
 * Usage: node scripts/rca_misfire_pathA_retest.mjs
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
  MIN_NORMALIZED_SCORE,
  SUSTAINED_COHERENT_SCORE,
  SUSTAINED_NORMALIZED_SCORE,
  LISTEN_SECONDS,
} from '../src/lib/constellationMatcher.js';
import { extendByCrossfadeLoop } from './lib/extendLoop.mjs';

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

function loadPcm(file) {
  const { pcm, rate } = decodeWav(fs.readFileSync(path.join(AUDIO_DIR, file)));
  let s = to16k(pcm, rate);
  if (s.length / SR < LISTEN_SECONDS * 2) s = extendByCrossfadeLoop(s, LISTEN_SECONDS * 2, SR);
  return s;
}

// ── Build the CANDIDATE index: shipped refs + misfire ───────────────────────
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/constellation_v1.json'), 'utf8'));

const MISFIRE = {
  label: 'Misfire', fault_type: 'misfire_detected_medium',
  severity: 'high', source_file: 'misfire_detected_medium.wav',
};

const misfirePcm = loadPcm(MISFIRE.source_file);
const mf = computeConstellationHashes(misfirePcm);

// Repack: the artifact stores refs[] plus parallel keys/vals arrays, each a
// base64-encoded Int32Array, where a val packs (refId << 20) | refTime.
// hydrateIndex() collects RUNS of equal keys, so the merged arrays must stay
// grouped by key — decode, merge, sort, re-encode.
const b64ToInt32 = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const int32ToB64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');

const sKeys = b64ToInt32(shipped.keys), sVals = b64ToInt32(shipped.vals);
const newId = shipped.refs.length;
const total = sKeys.length + mf.h.length;
const pairs = new Array(total);
for (let i = 0; i < sKeys.length; i++) pairs[i] = [sKeys[i], sVals[i]];
for (let i = 0; i < mf.h.length; i++) {
  pairs[sKeys.length + i] = [mf.h[i], (newId << 20) | (mf.t[i] & 0xfffff)];
}
pairs.sort((a, b) => a[0] - b[0]);

const mKeys = new Int32Array(total), mVals = new Int32Array(total);
for (let i = 0; i < total; i++) { mKeys[i] = pairs[i][0]; mVals[i] = pairs[i][1]; }

const candidate = {
  ...shipped,
  refs: [...shipped.refs, { ...MISFIRE, hash_count: mf.h.length }],
  reference_count: shipped.refs.length + 1,
  keys: int32ToB64(mKeys),
  vals: int32ToB64(mVals),
  entry_count: total,
};

console.log('══ Misfire → Path A re-test (CANDIDATE index, nothing written) ══\n');
console.log(`shipped: ${shipped.refs.length} refs / ${shipped.entry_count} entries`);
console.log(`candidate: ${candidate.refs.length} refs / ${candidate.entry_count} entries`);
console.log(`misfire contributes ${mf.h.length} hashes`);
console.log(`Gates: instant >=${MIN_COHERENT_SCORE}/${MIN_NORMALIZED_SCORE}  `
  + `sustained >=${SUSTAINED_COHERENT_SCORE}/${SUSTAINED_NORMALIZED_SCORE}\n`);

hydrateIndex(candidate);

const negatives = fs.readdirSync(AUDIO_DIR).filter(f => f.startsWith('Negative_'));
const crossFamily = shipped.refs.map(r => r.source_file)
  .filter(f => fs.existsSync(path.join(AUDIO_DIR, f)));

let worstNeg = { file: null, score: 0, norm: 0, as: null };
let misfireFires = 0;

console.log('── Negatives against the CANDIDATE index ──');
console.log('file                                  score   norm    best-ref                  fires?  as-misfire?');
for (const file of [...negatives, ...crossFamily]) {
  const pcm = loadPcm(file);
  const matcher = createRollingMatcher();
  const BLOCK = 4096, TRY_EVERY = Math.round(SR * 0.9);
  let since = 0, peak = { score: 0, normalized: 0, ref: null }, fired = null;
  for (let off = 0; off + BLOCK <= pcm.length; off += BLOCK) {
    matcher.push(pcm.subarray(off, off + BLOCK));
    since += BLOCK;
    if (since < TRY_EVERY) continue;
    since = 0;
    const m = matcher.tryMatch();
    if (!m) continue;
    if (m.score > peak.score) peak = m;
    if (m.matched && !fired) fired = m;
  }
  const isNeg = file.startsWith('Negative_');
  const asMisfire = fired?.ref?.fault_type === 'misfire_detected_medium';
  if (asMisfire) misfireFires++;
  if (isNeg && peak.score > worstNeg.score) {
    worstNeg = { file, score: peak.score, norm: peak.normalized, as: peak.ref?.fault_type ?? null };
  }
  // A fault reference matching ITSELF is the intended behaviour, not a collision.
  const selfMatch = !isNeg && fired?.ref?.source_file === file;
  const flag = asMisfire ? 'AS-MISFIRE' : selfMatch ? 'self' : fired ? 'CROSS' : '-';
  console.log(
    `${file.slice(0, 36).padEnd(37)} ${String(peak.score).padStart(5)}  `
    + `${(peak.normalized || 0).toFixed(4)}  ${(peak.ref?.fault_type ?? '-').padEnd(24)} `
    + `${(fired ? 'YES' : 'no ').padEnd(6)}  ${flag}`);
}

console.log('\n── Result ──');
console.log(`worst pure negative: ${worstNeg.file ?? 'n/a'} `
  + `score=${worstNeg.score} norm=${worstNeg.norm.toFixed?.(4) ?? worstNeg.norm} `
  + `(gate ${MIN_COHERENT_SCORE}, sustained ${SUSTAINED_COHERENT_SCORE})`);
console.log(`negatives that fired AS MISFIRE: ${misfireFires}`);
console.log(`headroom to the sustained gate: ${SUSTAINED_COHERENT_SCORE - worstNeg.score}`);

console.log('\n⚠ NOT A SHIP DECISION. The exclusion was driven by HEALTHY ENGINE');
console.log('  IDLE audio (measured 496-523, sustained x4). That audio is in the');
console.log('  anomaly-patterns bucket, which this container cannot reach, so the');
console.log('  decisive negatives did not run. Re-run with bucket access before');
console.log('  changing EXCLUDED in build_constellation_index.mjs.');
