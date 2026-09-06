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
const PROJECT = process.env.SUPABASE_PROJECT_REF || 'bdldmkhcdtlqxaopxlam';
const BUCKET_NAME = 'anomaly-patterns';
// SUPABASE_URL exists so the read path can be pointed at a mock or a staging
// project without editing this file — scripts/qa_bucket_read.mjs uses it to
// exercise pagination, folder recursion and retry offline.
const ORIGIN = (process.env.SUPABASE_URL || `https://${PROJECT}.supabase.co`).replace(/\/+$/, '');
const BUCKET = `${ORIGIN}/storage/v1/object/public/${BUCKET_NAME}/`;
const LIST_URL = `${ORIGIN}/storage/v1/object/list/${BUCKET_NAME}`;
// The ANON key is public by design — it is shipped in the browser bundle and is
// safe in source. It is read from the environment first so a key rotation does
// not require a code edit. NEVER put a service_role key here: it bypasses Row
// Level Security entirely, and this script only needs public read.
const ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';

// Storage read tuning. The bucket is the SOLE source, so reading it must be
// complete and verifiable — a silently short read produces a silently
// incomplete index, which is worse than a build that fails loudly.
const LIST_PAGE = 100;        // Supabase caps a list page; paginate by offset
const MAX_LIST_PAGES = 200;   // hard stop so a paging bug cannot loop forever
const MAX_FOLDER_DEPTH = 4;   // recurse into subfolders, but not unboundedly
const FETCH_RETRIES = 4;      // transient 5xx / socket resets are common
const RETRY_BASE_MS = 500;    // 0.5s, 1s, 2s, 4s
const DOWNLOAD_CONCURRENCY = 6;
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

// ── Reference budget ────────────────────────────────────────────────────────
// Path A is an EXACT-RECORDING matcher: it recognises the recordings in its
// index and nothing else. Indexing one representative per family therefore
// left every other bucket recording to the embedding path, which measurement
// showed only generalises for power_steering
// (scripts/rca_pathb_separability.mjs). So admit SEVERAL recordings per family.
//
// The limit is false positives, and the cost is NOT linear. Sweeping the total
// reference count against the negative controls
// (scripts/rca_dedup_sweep.mjs, scripts/rca_full_bucket_coverage.mjs):
//
//   total refs   worst negative   headroom to the 480 sustained gate
//        8 (shipped)   153              327
//       20             153              327   <- unchanged
//       24             204              276
//       28             253              227
//       36             351              129
//       52             382               98
//
// Headroom is untouched up to 20 references and degrades from 24 onward, as
// coincidental hits accumulate across a denser hash space. This is the same
// effect the pre-ship review recorded when near-duplicates raised the worst
// healthy negative from 237 to 443.
//
// 20 is therefore a MEASURED ceiling, not a guess. Note the negatives that can
// be tested here are speech, noise, music and silence; healthy ENGINE IDLE sits
// acoustically far closer to a pump whine and lives in the bucket, so the real
// headroom is smaller than these numbers. Staying inside the flat region of the
// curve is what makes that unmeasured margin safe to spend.
const MAX_REFS_PER_FAMILY = 3;
const MAX_TOTAL_REFS = 20;
// A candidate that already matches the partial index this strongly is ALREADY
// detected, so indexing it buys no coverage and only adds hash density.
// Measured: at 1200 the 44 power_steering recordings still scored 44/44
// coverage with 35 of 44 admitted.
const DEDUP_SCORE = 1200;

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
//
// Reading the bucket has to be COMPLETE, not best-effort. A truncated listing
// or a dropped download does not fail the build — it silently produces an index
// missing references, and a missing reference is a fault the app can no longer
// detect. Every read below therefore either succeeds or aborts the build.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** fetch with bounded retry on transient failures. 4xx is not retried. */
async function fetchRetry(url, init = {}, what = url) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    if (attempt) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, init);
      // A 4xx is a real answer — retrying will not change it.
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`HTTP ${res.status} ${res.statusText} (not retryable)`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (/not retryable/.test(e.message)) break;
      if (attempt < FETCH_RETRIES) {
        console.warn(`  retry ${attempt + 1}/${FETCH_RETRIES} — ${what}: ${e.message}`);
      }
    }
  }
  throw new Error(`${what}: ${lastErr.message}`);
}

/**
 * List every .wav in the bucket, paginating by offset and recursing into
 * folders. The previous single `limit: 1000` call had two silent failure
 * modes: a bucket larger than one page was truncated, and anything inside a
 * folder was invisible (Supabase returns folders as entries with a null id,
 * not as their contents).
 */
async function listAllWavs(prefix = '', depth = 0) {
  if (depth > MAX_FOLDER_DEPTH) {
    console.warn(`  folder depth limit reached at "${prefix}" — not recursing further`);
    return [];
  }
  const found = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await fetchRetry(LIST_URL, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix, limit: LIST_PAGE, offset: page * LIST_PAGE,
        sortBy: { column: 'name', order: 'asc' },
      }),
    }, `list "${prefix || '/'}" page ${page}`);

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const o of batch) {
      const full = prefix ? `${prefix}/${o.name}` : o.name;
      // Supabase marks a folder placeholder with a null id.
      if (o.id === null || o.id === undefined) {
        found.push(...await listAllWavs(full, depth + 1));
      } else if (/\.wav$/i.test(o.name)) {
        found.push(full);
      }
    }
    if (batch.length < LIST_PAGE) break;   // short page = last page
    if (page === MAX_LIST_PAGES - 1) {
      throw new Error(`listing "${prefix || '/'}" exceeded ${MAX_LIST_PAGES} pages — aborting rather than truncating`);
    }
  }
  return found;
}

console.log(`[constellation] listing bucket ${LIST_URL}`);
let wavs = [];
try {
  wavs = await listAllWavs();
} catch (e) {
  console.error(`[constellation] FATAL: cannot list the bucket — ${e.message}`);
  console.error('[constellation] The bucket is the only source; refusing to write a partial index.');
  process.exit(1);
}
if (wavs.length === 0) {
  console.error('[constellation] FATAL: the bucket listed zero .wav objects.');
  console.error('[constellation] Refusing to write an empty index.');
  process.exit(1);
}
console.log(`[constellation] ${wavs.length} wav objects in bucket`);

// Download every candidate once, recording its true duration so selection is
// made on evidence rather than filename. Downloads run with modest concurrency;
// ANY failure aborts the build, for the same reason a failed listing does.
const wanted = wavs.filter(name => {
  const base = name.split('/').pop();
  if (EXCLUDED.has(base)) { console.log(`  SKIP ${name} (excluded — see EXCLUDED)`); return false; }
  return true;
});

const candidates = new Map();   // fault_type -> [{name, pcm, seconds}]
const failures = [];
let nextDownload = 0;

async function downloadWorker() {
  while (nextDownload < wanted.length) {
    const name = wanted[nextDownload++];
    try {
      const url = BUCKET + name.split('/').map(encodeURIComponent).join('/');
      const res = await fetchRetry(url, {}, name);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty body');
      const { pcm, rate } = decodeWav(buf);
      const pcm16 = resample(pcm, rate);
      if (pcm16.length === 0) throw new Error('decoded to zero samples');
      const meta = deriveMeta(name.split('/').pop());
      if (!candidates.has(meta.fault_type)) candidates.set(meta.fault_type, []);
      candidates.get(meta.fault_type).push({ name, pcm: pcm16, seconds: pcm16.length / SR });
    } catch (e) {
      failures.push(`${name}: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, downloadWorker));

if (failures.length) {
  console.error(`[constellation] FATAL: ${failures.length} of ${wanted.length} downloads failed:`);
  for (const f of failures) console.error(`    ${f}`);
  console.error('[constellation] A dropped reference is a fault the app can no longer detect.');
  console.error('[constellation] Refusing to write a partial index.');
  process.exit(1);
}
console.log(`[constellation] downloaded ${wanted.length} references across ${candidates.size} families`);

// Candidate admission, in order:
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
//   2. LONGEST first — more frames means a stronger coherence spike.
//   3. DEDUP — a candidate already matching the partial index at DEDUP_SCORE
//      is already detected, so it would add density without coverage.
//   4. BUDGET — MAX_REFS_PER_FAMILY, then the measured MAX_TOTAL_REFS ceiling.
//
// Families are filled ROUND-ROBIN rather than one at a time, so a family with
// 45 recordings cannot consume the whole budget before a family with 3 is
// reached. The thin families are exactly the ones the embedding path cannot
// carry, so they must not be starved.
console.log(`[constellation] admitting up to ${MAX_REFS_PER_FAMILY}/family, ${MAX_TOTAL_REFS} total...`);

const pools = new Map();
for (const [faultType, list] of [...candidates.entries()].sort()) {
  for (const c of list) if (c.flatness === undefined) c.flatness = spectralFlatness(c.pcm);
  for (const c of list.filter(c => c.flatness < MIN_SPECTRAL_FLATNESS)) {
    console.log(`  SKIP ${c.name} (spectral flatness ${c.flatness.toFixed(4)} < ${MIN_SPECTRAL_FLATNESS} — too tonal, would collide with pure tones)`);
  }
  const usable = list.filter(c => c.flatness >= MIN_SPECTRAL_FLATNESS);
  if (usable.length === 0) {
    console.log(`  [${faultType}] no broadband candidate — family left to the embedding path`);
    continue;
  }
  usable.sort((a, b) => b.seconds - a.seconds);
  pools.set(faultType, usable);
}

// Hash -> packed entries for the references admitted so far, maintained
// alongside pairs[] so the dedup check does not rebuild it per candidate.
const admittedIndex = new Map();
function noteAdmitted(fromPairIndex) {
  for (let i = fromPairIndex; i < pairs.length; i++) {
    const p = pairs[i];
    let arr = admittedIndex.get(p.h);
    if (!arr) { arr = []; admittedIndex.set(p.h, arr); }
    arr.push(p.packed);
  }
}

/** Best time-coherent score of a candidate against what is already indexed. */
function scoreAgainstAdmitted(fp) {
  if (admittedIndex.size === 0) return 0;
  const perRef = new Map();
  for (let i = 0; i < fp.h.length; i++) {
    const hits = admittedIndex.get(fp.h[i]);
    if (!hits) continue;
    for (const packed of hits) {
      const refId = packed >>> 20, off = (packed & 0xfffff) - fp.t[i];
      let m = perRef.get(refId);
      if (!m) { m = new Map(); perRef.set(refId, m); }
      m.set(off, (m.get(off) || 0) + 1);
    }
  }
  let best = 0;
  for (const m of perRef.values()) for (const c of m.values()) if (c > best) best = c;
  return best;
}

// admitted = references actually indexed for the family (what the cap limits).
// cursor   = how far through that family's candidate list we have looked, so a
//            skipped duplicate is not re-examined on the next round.
const admitted = new Map([...pools.keys()].map(k => [k, 0]));
const cursor = new Map([...pools.keys()].map(k => [k, 0]));

outer:
for (let round = 0; round < MAX_REFS_PER_FAMILY; round++) {
  let progressed = false;
  for (const [faultType, usable] of pools) {
    if (admitted.get(faultType) > round) continue;
    if (refs.length >= MAX_TOTAL_REFS) {
      console.log(`  BUDGET reached (${MAX_TOTAL_REFS} references) — remaining candidates left to the embedding path`);
      break outer;
    }
    let i = cursor.get(faultType);
    while (i < usable.length) {
      const c = usable[i++];
      const extended = extendByCrossfadeLoop(c.pcm, TARGET_SECONDS, SR);
      const fp = computeConstellationHashes(extended);
      const dup = scoreAgainstAdmitted(fp);
      if (dup >= DEDUP_SCORE) {
        console.log(`  SKIP ${c.name} (already matches the index at ${dup} >= ${DEDUP_SCORE} — covered, would only add density)`);
        continue;
      }
      const note = extended.length > c.pcm.length
        ? `looped ${c.seconds.toFixed(1)}s -> ${(extended.length / SR).toFixed(1)}s`
        : 'native length';
      console.log(`  [${faultType}] ${c.name}  (${note}, flatness ${c.flatness.toFixed(4)})`);
      const before = pairs.length;
      addReference(c.name, extended, c.name);
      if (pairs.length > before) {          // addReference can still reject
        noteAdmitted(before);
        admitted.set(faultType, admitted.get(faultType) + 1);
        progressed = true;
        break;
      }
    }
    cursor.set(faultType, i);
  }
  if (!progressed) break;
}

for (const [faultType, usable] of pools) {
  const left = usable.length - admitted.get(faultType);
  if (left > 0) console.log(`  [${faultType}] ${left} further candidate(s) left to the embedding path`);
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
