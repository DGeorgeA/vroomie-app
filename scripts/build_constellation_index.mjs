/**
 * build_constellation_index.mjs — offline builder for the Shazam-style index.
 *
 * Imports the hashing from src/lib/constellationMatcher.js so index-time and
 * query-time fingerprinting are provably the same code. Sources, in priority
 * order:
 *   1. audio_files/extended_10s/*.wav  (10 s crossfade-looped originals — more
 *      frames means a stronger coherence spike)
 *   2. distinct bucket classes not covered above
 * The 44 near-duplicate power-steering bucket variants are deliberately NOT
 * all indexed: constellation matching identifies exact recordings, so
 * duplicates add index weight without adding discriminative power. A few
 * representatives are enough.
 *
 * Output: public/constellation_v1.json  (compact base64 Int32 arrays)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeConstellationHashes, SR } from '../src/lib/constellationMatcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC10 = path.resolve(ROOT, '..', 'audio_files', 'extended_10s');
const OUT = path.join(ROOT, 'public', 'constellation_v1.json');
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const LIST_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/list/anomaly-patterns';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const EXCLUDED = new Set(['water_pump_failure_critical.wav']);   // synthetic tone
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

console.log('[constellation] indexing extended 10 s originals...');
const covered = new Set();
if (fs.existsSync(SRC10)) {
  for (const name of fs.readdirSync(SRC10).filter(f => f.toLowerCase().endsWith('.wav'))) {
    const { pcm, rate } = decodeWav(fs.readFileSync(path.join(SRC10, name)));
    addReference(name, resample(pcm, rate), name);
    covered.add(deriveMeta(name).fault_type);
  }
} else {
  console.warn('[constellation] extended_10s not found — run scripts/extend_reference_wavs.py first');
}

console.log('[constellation] indexing remaining distinct bucket classes...');
try {
  const res = await fetch(LIST_URL, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 200, sortBy: { column: 'name', order: 'asc' } }),
  });
  const wavs = (await res.json()).filter(o => /\.wav$/i.test(o.name)).map(o => o.name);
  for (const name of wavs) {
    if (EXCLUDED.has(name)) { console.log(`  SKIP ${name} (excluded)`); continue; }
    const meta = deriveMeta(name);
    const isPS = meta.fault_type === 'power_steering';
    // Skip classes already covered by a 10 s original, except keep a few PS
    // representatives (that family has genuinely distinct recordings).
    if (covered.has(meta.fault_type) && !isPS) continue;
    // PS bucket variants are 1.5 s — all fall below MIN_REF_SECONDS and are
    // covered by the 10 s PowerSteeringPump reference + the embedding path.
    if (isPS) continue;
    try {
      const buf = Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer());
      const { pcm, rate } = decodeWav(buf);
      addReference(name, resample(pcm, rate), name);
    } catch (e) { console.warn(`  ${name}: ${e.message}`); }
  }
} catch (e) {
  console.warn('[constellation] bucket listing failed:', e.message);
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
