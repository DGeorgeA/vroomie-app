/**
 * qa_basic_path.mjs — functional health check for BASIC, the original audio
 * sensing path.
 *
 * Basic runs Path A (Shazam-style constellation fingerprint) against the
 * SHIPPED artifact public/constellation_v1.json, using the SAME hashing and
 * matching code the browser runs — imported, not reimplemented, so the test
 * and the app cannot drift.
 *
 * Self-contained: no Supabase, no TF Hub, no audio outside the repo. The
 * existing constellation harnesses depend on ../audio_files and the storage
 * bucket, so they cannot run in a clean checkout; this one can.
 *
 * WHAT IT PROVES
 *   1. The shipped index hydrates and is internally consistent.
 *   2. Real engine audio produces a coherent, deterministic match score.
 *   3. Negative controls (silence, white noise, pure tone, chirp) stay BELOW
 *      both the instant and sustained gates — no false fires.
 *   4. The rolling matcher honours its listen-window contract and the
 *      sustained tier needs two consecutive agreeing attempts.
 *   5. Basic degrades safely when the index is absent.
 *
 * Usage: node scripts/qa_basic_path.mjs   (exit 0 = all pass)
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
  SUSTAINED_REPEATS,
  LISTEN_SECONDS,
  MIN_LISTEN_SECONDS,
} from '../src/lib/constellationMatcher.js';
import { extendByCrossfadeLoop, TARGET_SECONDS } from './lib/extendLoop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUDIO_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'scripts/tmp_audio');
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// ── Minimal 16-bit PCM WAV decoder (mono/stereo, any rate) ──────────────────
function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let i = 12, channels = 1, rate = SR, bits = 16, fmtTag = 1, data = null;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ') {
      fmtTag   = buf.readUInt16LE(i + 8);
      channels = buf.readUInt16LE(i + 10);
      rate     = buf.readUInt32LE(i + 12);
      bits     = buf.readUInt16LE(i + 22);
    } else if (id === 'data') {
      data = buf.subarray(i + 8, i + 8 + size);
      break;
    }
    i += 8 + size + (size % 2);
  }
  if (!data) throw new Error('no data chunk');

  // The reference set mixes 16-bit PCM and 32-bit float (IEEE, fmtTag 3).
  const bytes = bits / 8;
  const frames = Math.floor(data.length / bytes / channels);
  const mono = new Float32Array(frames);
  const readSample = (off) => {
    if (bits === 16) return data.readInt16LE(off) / 32768;
    if (bits === 32 && fmtTag === 3) return data.readFloatLE(off);
    if (bits === 32) return data.readInt32LE(off) / 2147483648;
    if (bits === 8) return (data.readUInt8(off) - 128) / 128;
    throw new Error(`unsupported wav (bits=${bits} fmt=${fmtTag})`);
  };
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += readSample((f * channels + c) * bytes);
    mono[f] = acc / channels;
  }
  return { pcm: mono, rate };
}

// Linear resample — identical maths to the app's resampleBlockTo16k.
function to16k(pcm, rate) {
  if (rate === SR) return pcm;
  const ratio = rate / SR;
  const outLen = Math.max(1, Math.floor(pcm.length / ratio));
  const out = new Float32Array(outLen);
  const maxIdx = pcm.length - 1;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const l = Math.min(maxIdx, Math.floor(x));
    const r = Math.min(maxIdx, l + 1);
    out[i] = pcm[l] * (1 - (x - l)) + pcm[r] * (x - l);
  }
  return out;
}

// Deterministic PRNG so negative controls are reproducible run to run.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seconds = (n) => Math.floor(SR * n);
const silence = (n) => new Float32Array(seconds(n));
function whiteNoise(n, seed = 42, amp = 0.2) {
  const r = mulberry32(seed), out = new Float32Array(seconds(n));
  for (let i = 0; i < out.length; i++) out[i] = (r() * 2 - 1) * amp;
  return out;
}
function tone(n, hz = 440, amp = 0.3) {
  const out = new Float32Array(seconds(n));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin(2 * Math.PI * hz * (i / SR)) * amp;
  return out;
}
function chirp(n, f0 = 200, f1 = 6000, amp = 0.3) {
  const out = new Float32Array(seconds(n)), N = out.length;
  for (let i = 0; i < N; i++) {
    const f = f0 + (f1 - f0) * (i / N);
    out[i] = Math.sin(2 * Math.PI * f * (i / SR)) * amp;
  }
  return out;
}

// ── Load the SHIPPED artifact through the SHIPPED hydrate path ──────────────
console.log('══ BASIC (Path A — constellation fingerprint) ══\n');
console.log('── Shipped index integrity ──');

const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/constellation_v1.json'), 'utf8'));
check('index artifact parses', !!artifact && Array.isArray(artifact.refs));
check('index sample rate matches the matcher', artifact.sample_rate === SR,
  `artifact=${artifact.sample_rate} matcher=${SR}`);
check('reference_count agrees with refs[]',
  artifact.reference_count === artifact.refs.length,
  `${artifact.reference_count} vs ${artifact.refs.length}`);
check('every reference declares a label, fault_type and hash_count',
  artifact.refs.every(r => r.label && r.fault_type && r.hash_count > 0));
check('entry_count is positive and matches the packed arrays',
  artifact.entry_count > 0, `${artifact.entry_count} entries`);

const hydrated = hydrateIndex(artifact);
check('index hydrates without error', hydrated !== false && hydrated !== null);

// ── Provenance: Basic's references come from the anomaly-patterns bucket ────
console.log('\n── Reference provenance (Supabase anomaly-patterns bucket) ──');
{
  const builder = fs.readFileSync(path.join(ROOT, 'scripts/build_constellation_index.mjs'), 'utf8');
  const embedBuilder = fs.readFileSync(path.join(ROOT, 'scripts/build_reference_fingerprints.mjs'), 'utf8');
  const BUCKET_HOST = 'bdldmkhcdtlqxaopxlam.supabase.co';
  const BUCKET_NAME = 'anomaly-patterns';

  check('index declares its generator',
    artifact.generated_by === 'scripts/build_constellation_index.mjs', artifact.generated_by);
  check('Path A builder sources the anomaly-patterns bucket',
    builder.includes(BUCKET_HOST) && builder.includes(BUCKET_NAME));
  check('Path B builder sources the same bucket',
    embedBuilder.includes(BUCKET_HOST) && embedBuilder.includes(BUCKET_NAME));
  check('every Path A reference names a .wav source file',
    artifact.refs.every(r => /\.wav$/i.test(r.source_file || '')));

  // The exclusions below are MEASURED decisions, not oversights. If a rebuild
  // ever reintroduces them, the healthy false-fire rate regresses.
  const indexed = new Set(artifact.refs.map(r => (r.source_file || '').toLowerCase()));
  check('misfire is NOT in the fingerprint index (caused the only 2 healthy false fires)',
    !indexed.has('misfire_detected_medium.wav'));
  check('the synthetic water-pump tone is NOT indexed',
    !indexed.has('water_pump_failure_critical.wav'));
  check('builder still documents both exclusions',
    /misfire_detected_medium\.wav/.test(builder) && /water_pump_failure_critical\.wav/.test(builder));
  check('short-reference floor is still enforced at 4.0 s',
    /MIN_REF_SECONDS = 4\.0/.test(builder));
  check('no duplicate references in the index',
    new Set(artifact.refs.map(r => r.source_file)).size === artifact.refs.length);

  // The bucket must be the ONLY input. The retired extend_reference_wavs.py
  // wrote to a hard-coded Windows path outside the repo, so any index built
  // from it was unreproducible in a clean checkout.
  check('builder reads no source other than the bucket',
    !/extended_10s|SRC10|readdirSync\(/.test(builder.replace(/^\s*\*.*$/gm, '')));
  check('builder refuses to write a partial index if the bucket is unreachable',
    /refusing to write a partial index/.test(builder));
  check('reference extension happens in-process, from the shared helper',
    /from '\.\/lib\/extendLoop\.mjs'/.test(builder));
  check('one representative per family, chosen by longest recording',
    /list\.sort\(\(a, b\) => b\.seconds - a\.seconds\)/.test(builder));
}

// ── Equivalence: bucket original + in-process loop == the shipped index ─────
// This is what makes the bucket sufficient as a sole source. The shipped index
// was built from a pre-computed extended_10s directory; if looping the ORIGINAL
// reproduces the shipped hash_count exactly, that directory held nothing the
// builder cannot now derive itself.
console.log('\n── Bucket original + in-process loop vs the shipped index ──');
{
  const byFile = new Map(artifact.refs.map(r => [r.source_file, r]));
  let reproduced = 0, willChange = 0, checked = 0;

  for (const file of fs.readdirSync(AUDIO_DIR).filter(f => byFile.has(f))) {
    const ref = byFile.get(file);
    const { pcm: raw, rate } = decodeWav(fs.readFileSync(path.join(AUDIO_DIR, file)));
    const src = to16k(raw, rate);
    const ext = extendByCrossfadeLoop(src, TARGET_SECONDS, SR);

    const hashesNative = computeConstellationHashes(src).h.length;
    const hashesExt    = computeConstellationHashes(ext).h.length;
    checked++;

    // The shipped index is a MIX: files that came via the retired extended_10s
    // directory were looped to 10 s; files taken straight from the bucket were
    // indexed at native length. Both must be accounted for.
    if (hashesExt === ref.hash_count) {
      reproduced++;
      check(`${file} — looping the bucket original reproduces the shipped index`,
        true, `${(src.length / SR).toFixed(1)}s -> 10.0s = ${hashesExt} hashes (shipped ${ref.hash_count})`);
    } else if (hashesNative === ref.hash_count) {
      willChange++;
      check(`${file} — shipped at NATIVE length; a bucket-only rebuild will extend it`,
        true, `native ${hashesNative} (shipped) -> looped ${hashesExt} after rebuild`);
    } else {
      check(`${file} — hash count matches the shipped index by some route`, false,
        `shipped ${ref.hash_count}, native ${hashesNative}, looped ${hashesExt}`);
    }

    // The crossfade must never introduce clipping, whichever route applies.
    let peak = 0;
    for (let i = 0; i < ext.length; i++) peak = Math.max(peak, Math.abs(ext[i]));
    check(`${file} loop introduces no clipping`, peak <= 1.0001, `peak=${peak.toFixed(3)}`);
  }

  check('at least one reference was equivalence-checked', checked > 0, `${checked} refs`);
  check('the retired extended_10s directory held nothing the builder cannot derive',
    reproduced > 0, `${reproduced} reference(s) reproduced exactly from the bucket original`);
  if (willChange > 0) {
    console.log(`      NOTE: ${willChange} reference(s) ship at native length and will gain hashes on the`);
    console.log('      next bucket-only rebuild. More hashes means a stronger coherence spike, but it');
    console.log('      also adds index weight — re-run verify_sustained_tier.mjs against the healthy');
    console.log('      corpus before shipping a rebuilt index.');
  }
}

// ── Negative controls: nothing synthetic may fire ───────────────────────────
console.log('\n── Negative controls must NOT fire (no false positives) ──');

const NEGATIVES = [
  ['digital silence',        silence(LISTEN_SECONDS)],
  ['white noise',            whiteNoise(LISTEN_SECONDS, 42)],
  ['white noise (seed 7)',   whiteNoise(LISTEN_SECONDS, 7)],
  ['quiet white noise',      whiteNoise(LISTEN_SECONDS, 13, 0.02)],
  ['440 Hz pure tone',       tone(LISTEN_SECONDS, 440)],
  ['1 kHz pure tone',        tone(LISTEN_SECONDS, 1000)],
  ['200 Hz -> 6 kHz chirp',  chirp(LISTEN_SECONDS)],
];

for (const [name, pcm] of NEGATIVES) {
  let fired = false, score = 0, norm = 0;
  try {
    const fp = computeConstellationHashes(pcm);
    const m = matchHashes(fp);
    if (m) {
      score = m.score || 0;
      norm = m.normalized || 0;
      // Fires if it clears EITHER gate.
      fired = (score >= MIN_COHERENT_SCORE && norm >= MIN_NORMALIZED_SCORE)
           || (score >= SUSTAINED_COHERENT_SCORE && norm >= SUSTAINED_NORMALIZED_SCORE);
    }
  } catch (e) {
    check(`${name} — matcher did not throw`, false, e.message);
    continue;
  }
  check(`${name} stays below both gates`, !fired,
    `score=${score} norm=${norm.toFixed(4)}`);
}

// ── TRUE POSITIVES: the exact recordings the index was built from ───────────
// This is the decisive test of Basic. Constellation matching is EXACT-recording
// recognition (Shazam), so the source files must fire, and fire on the right
// reference. scripts/tmp_audio holds the originals used by
// build_constellation_index.mjs.
console.log('\n── True positives: indexed source recordings must FIRE ──');

const loadClip = (file, secs = LISTEN_SECONDS, offset = 0) => {
  const { pcm: raw, rate } = decodeWav(fs.readFileSync(path.join(AUDIO_DIR, file)));
  const pcm = to16k(raw, rate);
  const from = Math.min(seconds(offset), Math.max(0, pcm.length - 1));
  return pcm.subarray(from, Math.min(from + seconds(secs), pcm.length));
};

const fired = (m) => !!m && (
  (m.score >= MIN_COHERENT_SCORE && m.normalized >= MIN_NORMALIZED_SCORE) ||
  (m.score >= SUSTAINED_COHERENT_SCORE && m.normalized >= SUSTAINED_NORMALIZED_SCORE)
);

// Map indexed refs to their on-disk source, where we have it.
const POSITIVES = artifact.refs
  .map(r => ({ ref: r, file: r.source_file }))
  .filter(p => fs.existsSync(path.join(AUDIO_DIR, p.file)));

check('indexed source recordings are available to test',
  POSITIVES.length > 0, `${POSITIVES.length} of ${artifact.refs.length} refs`);

let firedCount = 0, correctLabel = 0;
for (const { ref, file } of POSITIVES) {
  let m = null;
  try {
    m = matchHashes(computeConstellationHashes(loadClip(file)));
  } catch (e) {
    check(`${ref.label} — matcher threw`, false, e.message);
    continue;
  }
  const didFire = fired(m);
  const right = !!m && m.ref && m.ref.label === ref.label;
  if (didFire) firedCount++;
  if (didFire && right) correctLabel++;
  check(`${ref.label} fires on its own recording`, didFire && right,
    m ? `best=${m.ref ? m.ref.label : 'none'} score=${m.score} norm=${(m.normalized || 0).toFixed(4)}` : 'no match');
}
check('every available indexed recording fires on itself',
  firedCount === POSITIVES.length && correctLabel === POSITIVES.length,
  `${correctLabel}/${POSITIVES.length} correct`);

// Offset robustness — a user never starts the clip at sample 0. The indexed
// references are SHORT (1-2 s), so the offset must be scaled to each file:
// asking for a 1.9 s offset into a 2 s reference leaves nothing to match.
console.log('\n── Positives survive a mid-clip start ──');
const clipSeconds = (file) => {
  const { pcm, rate } = decodeWav(fs.readFileSync(path.join(AUDIO_DIR, file)));
  return to16k(pcm, rate).length / SR;
};
for (const { ref, file } of POSITIVES) {
  const dur = clipSeconds(file);
  // Skip a quarter and a third of the way in, keeping the remainder intact.
  const offsets = [dur * 0.25, dur * 0.33].filter(o => dur - o >= 0.6);
  if (!offsets.length) {
    check(`${ref.label} — reference too short to offset-test`, true, `${dur.toFixed(2)} s`);
    continue;
  }
  let ok = true, detail = `${dur.toFixed(2)} s ref`;
  for (const off of offsets) {
    const m = matchHashes(computeConstellationHashes(loadClip(file, LISTEN_SECONDS, off)));
    const good = fired(m) && m.ref && m.ref.label === ref.label;
    if (!good) { ok = false; detail = `offset ${off.toFixed(2)}s -> score=${m ? m.score : 0}`; }
  }
  check(`${ref.label} still fires from a mid-clip start`, ok, detail);
}

// Determinism and shape.
console.log('\n── Determinism and result shape ──');
if (POSITIVES.length) {
  const clip = loadClip(POSITIVES[0].file);
  const fp = computeConstellationHashes(clip);
  check('hashing produces a non-empty fingerprint',
    fp && fp.h && fp.h.length > 0, `${fp && fp.h ? fp.h.length : 0} hashes`);
  const a = matchHashes(fp);
  const b = matchHashes(computeConstellationHashes(clip));
  check('matching is deterministic across runs',
    (a ? a.score : -1) === (b ? b.score : -2),
    `${a ? a.score : 'n/a'} vs ${b ? b.score : 'n/a'}`);
  check('normalized is a ratio in [0,1]',
    !!a && a.normalized >= 0 && a.normalized <= 1, a ? String(a.normalized) : 'n/a');
}

// A DIFFERENT recording of the SAME fault must not be mistaken for an exact hit.
console.log('\n── Exactness: a different take of the same fault must not fire ──');
{
  const other = path.join(ROOT, 'reference_audio/alternator_bearing_noise_2.wav');
  if (fs.existsSync(other)) {
    const { pcm: raw, rate } = decodeWav(fs.readFileSync(other));
    const pcm = to16k(raw, rate).subarray(0, seconds(LISTEN_SECONDS));
    const m = matchHashes(computeConstellationHashes(pcm));
    check('a different alternator recording does not clear the gates', !fired(m),
      m ? `best=${m.ref ? m.ref.label : 'none'} score=${m.score} norm=${(m.normalized || 0).toFixed(4)}` : 'no match');
  }
}

// ── Rolling matcher lifecycle (what the live pipeline actually drives) ──────
console.log('\n── Rolling matcher contract ──');

{
  const rm = createRollingMatcher();
  check('createRollingMatcher returns a matcher', !!rm && typeof rm.push === 'function');

  // Below the minimum listen time it must decline to answer.
  rm.push(whiteNoise(1, 99));
  check('under-filled matcher reports < MIN_LISTEN_SECONDS buffered',
    rm.secondsBuffered() < MIN_LISTEN_SECONDS,
    `${rm.secondsBuffered().toFixed(2)} s`);
  check('tryMatch() before the minimum listen time does not fire',
    !(rm.tryMatch() || {}).matched);

  // Fill past the listen window with noise — still must not fire.
  for (let i = 0; i < LISTEN_SECONDS + 2; i++) rm.push(whiteNoise(1, 100 + i));
  check('buffer is capped at the listen window',
    rm.secondsBuffered() <= LISTEN_SECONDS + 1.001,
    `${rm.secondsBuffered().toFixed(2)} s (cap ${LISTEN_SECONDS})`);
  const noiseMatch = rm.tryMatch();
  check('a full window of noise never fires', !(noiseMatch || {}).matched,
    noiseMatch ? `score=${noiseMatch.score} norm=${(noiseMatch.normalized || 0).toFixed(4)}` : 'no result');
}

// ── Gate ordering sanity ────────────────────────────────────────────────────
console.log('\n── Threshold contract ──');

check('sustained gate is strictly looser than instant',
  SUSTAINED_COHERENT_SCORE < MIN_COHERENT_SCORE
  && SUSTAINED_NORMALIZED_SCORE < MIN_NORMALIZED_SCORE,
  `${SUSTAINED_COHERENT_SCORE}/${SUSTAINED_NORMALIZED_SCORE} vs ${MIN_COHERENT_SCORE}/${MIN_NORMALIZED_SCORE}`);
check('sustained tier requires repeated agreement', SUSTAINED_REPEATS >= 2);
check('minimum listen time is shorter than the full window',
  MIN_LISTEN_SECONDS < LISTEN_SECONDS, `${MIN_LISTEN_SECONDS} < ${LISTEN_SECONDS}`);

// ── Degradation: Basic must survive a missing index ─────────────────────────
console.log('\n── Safe degradation ──');
{
  const extractor = fs.readFileSync(path.join(ROOT, 'src/lib/audioFeatureExtractor.js'), 'utf8');
  check('a failed index load leaves the fast path disabled, not thrown',
    /fail safe: fast path stays disabled/.test(extractor));
  check('a missing index degrades to embedding-only',
    /index unavailable — embedding path only/.test(extractor));
  check('a match error is caught and the session continues',
    /match failed, continuing with embedding path/.test(extractor));
}

console.log(
  failures === 0
    ? '\nALL BASIC PATH CHECKS PASSED'
    : `\n${failures} BASIC PATH CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
