/**
 * build_constellation_index.mjs — offline builder for the Shazam-style index.
 *
 * SINGLE SOURCE OF TRUTH: the Supabase storage bucket `anomaly-patterns`.
 * Nothing else. Previously this also read a local audio_files/extended_10s
 * directory produced by scripts/extend_reference_wavs.py, which wrote to a
 * hard-coded Windows path outside the repository — so the index could not be
 * reproduced on any other machine, and the shipped artifact depended on files
 * no checkout contained. That source is gone.
 *
 * Imports the hashing from src/lib/constellationMatcher.js so index-time and
 * query-time fingerprinting are provably the same code.
 *
 * REFERENCE EXTENSION (moved in-process, was extend_reference_wavs.py):
 * constellation matching scales with reference duration — more frames means
 * more hashes means a stronger time-offset coherence spike — and most bucket
 * originals are only 1-2 s, below MIN_REF_SECONDS. Short references are
 * therefore crossfade-looped up to TARGET_SECONDS here, in memory. These are
 * steady-state mechanical sounds, so seamless looping is acoustically
 * faithful: a 2 s alternator whine and a 10 s alternator whine are the same
 * physical signal. The loop uses a 50 ms equal-power crossfade because a naive
 * concatenation leaves a click, and a click registers as spurious spectral
 * peaks that pollute the constellation.
 *
 * ONE REPRESENTATIVE PER FAMILY: constellation matching identifies exact
 * recordings, so near-duplicates (the bucket holds 44 power-steering variants)
 * add index weight without adding discriminative power. The longest recording
 * in each family is indexed; the rest are covered by the embedding path.
 *
 * Output: public/constellation_v1.json  (compact base64 Int32 arrays)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeConstellationHashes, SR } from '../src/lib/constellationMatcher.js';
import { extendByCrossfadeLoop, TARGET_SECONDS, XFADE_SECONDS } from './lib/extendLoop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'constellation_v1.json');
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const LIST_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/list/anomaly-patterns';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const EXCLUDED = new Set([
  'water_pump_failure_critical.wav',   // synthetic tone, not a recording
  // Misfire is acoustically an IRREGULAR IDLE, so its fingerprint collides
  // with rough-but-healthy idling engines: it produced the only two healthy
  // false fires measured (scores 496-523, sustained across 4 consecutive
  // attempts, so persistence could not separate them). Excluded from the
  // fingerprint index only — misfire detection continues via the embedding
  // path, which discriminates it using healthy anchors.
  'misfire_detected_medium.wav',
]);
// Pre-ship review (scripts/review_constellation_shipped.mjs) measured that
// 1.5 s references CANNOT pass their own replay (PS_10 looped: 385/0.035 vs
// 400/0.05) and their dense near-duplicate hashes inflated the worst healthy
// negative from 237 to 443. References shorter than this are excluded; the
// embedding path covers those files (measured DETECTED in the v9.9 matrix).
const MIN_REF_SECONDS = 4.0;

function decodeWav(buf) {
  let pos = 12, fmt = null, off = 0, len = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), sz = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { fmtCode: buf.readUInt16LE(pos + 8), ch: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    else if (id === 'data') { off = pos + 8; len = sz; }
    pos += 8 + sz + (sz % 2);
  }
  if (!fmt || !off) throw new Error('missing fmt/data');
  const n = fmt.bits === 16 ? len / 2 : len / 4;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = fmt.bits === 16 ? buf.readInt16LE(off + i * 2) / 32768
      : (fmt.fmtCode === 3 ? buf.readFloatLE(off + i * 4) : buf.readInt32LE(off + i * 4) / 2147483648);
  }
  let m = x;
  if (fmt.ch > 1) {
    m = new Float32Array(Math.floor(n / fmt.ch));
    for (let i = 0; i < m.length; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += x[i * fmt.ch + c]; m[i] = s / fmt.ch; }
  }
  return { pcm: m, rate: fmt.rate };
}
function resample(p, from) {
  if (from === SR) return p;
  const r = from / SR, o = new Float32Array(Math.floor(p.length / r));
  for (let i = 0; i < o.length; i++) { const s = i * r, i0 = Math.floor(s), f = s - i0; o[i] = (p[i0] || 0) * (1 - f) + (p[i0 + 1] || 0) * f; }
  return o;
}

// Spectral flatness (Wiener entropy): geometric mean / arithmetic mean of the
// power spectrum. 1.0 is white noise; values approaching 0 are a pure tone.
// Averaged over frames spread across the clip so a single quiet passage cannot
// dominate. MEASURED on the shipped references:
//   MotorStarter 0.191 · BearingAlternator 0.147 · Piston 0.102
//   alternator_bearing_fault_critical 0.061  <- false-fires on pure tones
const MIN_SPECTRAL_FLATNESS = 0.08;
const FLATNESS_NFFT = 1024;
const FLATNESS_FRAMES = 12;

function spectralFlatness(pcm) {
  const N = FLATNESS_NFFT;
  if (pcm.length < N) return 1; // too short to judge — do not reject on this
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const step = Math.max(1, Math.floor((pcm.length - N) / FLATNESS_FRAMES));
  let acc = 0, frames = 0;
  for (let off = 0; off + N <= pcm.length && frames < FLATNESS_FRAMES; off += step) {
    let logSum = 0, linSum = 0;
    for (let k = 0; k < N / 2; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const v = pcm[off + n] * win[n];
        const a = (-2 * Math.PI * k * n) / N;
        re += v * Math.cos(a);
        im += v * Math.sin(a);
      }
      const power = re * re + im * im + 1e-12;
      logSum += Math.log(power);
      linSum += power;
    }
    const bins = N / 2;
    acc += Math.exp(logSum / bins) / (linSum / bins);
    frames++;
  }
  return frames ? acc / frames : 1;
}

/** Mirror of the factory's label derivation so families stay consistent. */
function deriveMeta(name) {
  const base = name.replace(/\.wav$/i, '');
  const lower = base.toLowerCase();
  let fault_type = 'unknown', label = base, severity = 'high';
  if (/piston/.test(lower)) { fault_type = 'piston_knock'; label = 'Piston'; }
  else if (/powersteering|power_steering/.test(lower)) { fault_type = 'power_steering'; label = 'PowerSteeringPump'; }
  else if (/rocker/.test(lower)) { fault_type = 'rocker_valve'; label = 'RockerArmAndValve'; }
  else if (/bearingalternator|alternator/.test(lower)) { fault_type = 'alternator_bearing_fault'; label = 'Alternator bearing noise'; }
  else if (/serpentine/.test(lower)) { fault_type = 'serpentine_belt'; label = 'SerpentineBelt'; }
  else if (/motorstarter|starter/.test(lower)) { fault_type = 'motor_starter'; label = 'MotorStarter'; }
  else if (/intake/.test(lower)) { fault_type = 'intake_leak'; label = 'Intake leak'; }
  else if (/misfire/.test(lower)) { fault_type = 'misfire_detected_medium'; label = 'Misfire'; }
  else if (/timing/.test(lower)) { fault_type = 'timing_chain'; label = 'Timing chain rattle'; }
  if (/critical/.test(lower)) severity = 'critical';
  return { label, fault_type, severity };
}

const refs = [];
const pairs = [];   // {h, packed}
let indexed = 0;

function addReference(name, pcm16, sourceFile) {
  const id = refs.length;
  if (id > 4095) { console.warn('reference id overflow — skipping', name); return; }
  if (pcm16.length / SR < MIN_REF_SECONDS) {
    console.log(`  SKIP ${name} (${(pcm16.length / SR).toFixed(1)}s < ${MIN_REF_SECONDS}s minimum — see review note)`);
    return;
  }
  const fp = computeConstellationHashes(pcm16);
  if (fp.h.length === 0) { console.warn(`  ${name}: no hashes, skipped`); return; }
  let maxT = 0;
  for (let i = 0; i < fp.t.length; i++) if (fp.t[i] > maxT) maxT = fp.t[i];
  if (maxT > 0xfffff) { console.warn(`  ${name}: too long to pack, skipped`); return; }
  // hash_count ships in the artifact: the runtime normalizes coherent score by
  // min(queryHashes, refHashes) so shorter references are not structurally
  // unable to reach the normalized threshold.
  refs.push({ ...deriveMeta(name), source_file: sourceFile, hash_count: fp.h.length });
  for (let i = 0; i < fp.h.length; i++) pairs.push({ h: fp.h[i], packed: (id << 20) | fp.t[i] });
  indexed++;
  console.log(`  ${name.padEnd(44)} ${(pcm16.length / SR).toFixed(1)}s  hashes=${fp.h.length}`);
}

// ── SOLE SOURCE: the anomaly-patterns bucket ────────────────────────────────
console.log(`[constellation] listing bucket ${LIST_URL}`);
let wavs = [];
try {
  const res = await fetch(LIST_URL, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new Error(`list HTTP ${res.status}`);
  wavs = (await res.json()).filter(o => /\.wav$/i.test(o.name)).map(o => o.name);
} catch (e) {
  console.error(`[constellation] FATAL: cannot list the bucket — ${e.message}`);
  console.error('[constellation] The bucket is the only source; refusing to write a partial index.');
  process.exit(1);
}
console.log(`[constellation] ${wavs.length} wav objects in bucket`);

// Download every candidate once, recording its true duration so the
// per-family representative can be chosen on evidence rather than filename.
const candidates = new Map();   // fault_type -> [{name, pcm, seconds}]
for (const name of wavs) {
  if (EXCLUDED.has(name)) { console.log(`  SKIP ${name} (excluded — see EXCLUDED)`); continue; }
  try {
    const buf = Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer());
    const { pcm, rate } = decodeWav(buf);
    const pcm16 = resample(pcm, rate);
    const meta = deriveMeta(name);
    if (!candidates.has(meta.fault_type)) candidates.set(meta.fault_type, []);
    candidates.get(meta.fault_type).push({ name, pcm: pcm16, seconds: pcm16.length / SR });
  } catch (e) {
    console.warn(`  ${name}: ${e.message}`);
  }
}

// One representative per family, chosen on TWO criteria:
//
//   1. TONALITY FLOOR (hard reject). A near-pure tone produces a sparse,
//      highly regular constellation that aligns coherently with ANY other
//      pure tone, so such a reference false-fires on ringtones, alarms and
//      beeps. MEASURED: selecting by duration alone picked
//      alternator_bearing_fault_critical.wav (spectral flatness 0.061) over
//      BearingAlternator.wav (0.147); pure tones at 330-1000 Hz then scored
//      689-721 against a 600 instant gate, versus 190-268 before. Every tone
//      in that band became a false "alternator bearing fault".
//      Same idea as the water_pump EXCLUDED entry, applied by measurement
//      rather than by filename.
//   2. LONGEST among survivors — more frames means a stronger coherence spike.
//
// Duration alone is NOT a safe selection rule. Flatness gates first.
console.log('[constellation] indexing one representative per family...');
for (const [faultType, list] of [...candidates.entries()].sort()) {
  for (const c of list) if (c.flatness === undefined) c.flatness = spectralFlatness(c.pcm);

  const tonal = list.filter(c => c.flatness < MIN_SPECTRAL_FLATNESS);
  for (const c of tonal) {
    console.log(`  SKIP ${c.name} (spectral flatness ${c.flatness.toFixed(4)} < ${MIN_SPECTRAL_FLATNESS} — too tonal, would collide with pure tones)`);
  }
  const usable = list.filter(c => c.flatness >= MIN_SPECTRAL_FLATNESS);
  if (usable.length === 0) {
    console.log(`  [${faultType}] no broadband candidate — family left to the embedding path`);
    continue;
  }

  usable.sort((a, b) => b.seconds - a.seconds);
  const pick = usable[0];
  const others = usable.length - 1;
  const extended = extendByCrossfadeLoop(pick.pcm, TARGET_SECONDS, SR);
  const note = extended.length > pick.pcm.length
    ? `looped ${pick.seconds.toFixed(1)}s -> ${(extended.length / SR).toFixed(1)}s`
    : 'native length';
  console.log(`  [${faultType}] ${pick.name}  (${note}, flatness ${pick.flatness.toFixed(4)}${others ? `, ${others} other candidate(s) left to the embedding path` : ''})`);
  addReference(pick.name, extended, pick.name);
}

// group by hash so the runtime can slice contiguous runs
pairs.sort((a, b) => (a.h - b.h) || (a.packed - b.packed));
const keys = new Int32Array(pairs.length);
const vals = new Int32Array(pairs.length);
for (let i = 0; i < pairs.length; i++) { keys[i] = pairs[i].h; vals[i] = pairs[i].packed; }
const toB64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');

const artifact = {
  version: 'constellation_v1',
  generated_by: 'scripts/build_constellation_index.mjs',
  sample_rate: SR,
  reference_count: refs.length,
  entry_count: pairs.length,
  refs,
  keys: toB64(keys),
  vals: toB64(vals),
};
fs.writeFileSync(OUT, JSON.stringify(artifact));
const distinct = new Set(keys).size;
console.log(`\n[constellation] ${indexed} references | ${pairs.length} entries | ${distinct} distinct hashes`);
console.log(`[constellation] families: ${[...new Set(refs.map(r => r.fault_type))].sort().join(', ')}`);
console.log(`[constellation] wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
