/**
 * rca_four_families.mjs — RCA for the reported miss on four fault families:
 *   alternator bearing, motor starter, misfire, piston.
 *
 * The question is narrow and answerable offline: for each family, what does
 * BASIC (Path A armed) score, and what does AI ENABLED (Path A NOT armed,
 * by the isolation change) have left to work with?
 *
 * Path A is measured here against the SHIPPED artifact using the SHIPPED
 * matcher — imported, not reimplemented. Path B cannot run in this container
 * (YAMNet is not cached and TF Hub is outside the network allowlist), so its
 * contribution is reported from the shipped reference census instead: how many
 * embeddings each family actually has to match against.
 *
 * Usage: node scripts/rca_four_families.mjs
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
} from '../src/lib/constellationMatcher.js';
import { extendByCrossfadeLoop } from './lib/extendLoop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUDIO_DIR = path.join(ROOT, 'scripts/tmp_audio');

// ── WAV decode + resample (same maths as the app's resampleBlockTo16k) ──────
function decodeWav(buf) {
  let i = 12, channels = 1, rate = SR, bits = 16, fmtTag = 1, data = null;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ') {
      fmtTag = buf.readUInt16LE(i + 8);
      channels = buf.readUInt16LE(i + 10);
      rate = buf.readUInt32LE(i + 12);
      bits = buf.readUInt16LE(i + 22);
    } else if (id === 'data') {
      data = buf.subarray(i + 8, i + 8 + size);
      break;
    }
    i += 8 + size + (size % 2);
  }
  if (!data) throw new Error('no data chunk');
  const bytes = bits / 8;
  const frames = Math.floor(data.length / bytes / channels);
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

const load = (file) => {
  const { pcm, rate } = decodeWav(fs.readFileSync(path.join(AUDIO_DIR, file)));
  return to16k(pcm, rate);
};

// The four families the user reported, plus a control family that IS working
// so the harness has a known-good reading to compare against.
const CASES = [
  { family: 'alternator_bearing_fault', file: 'BearingAlternator.wav', reported: true },
  { family: 'alternator_bearing_fault', file: 'alternator_bearing_fault_critical.wav', reported: true },
  { family: 'motor_starter', file: 'MotorStarter.wav', reported: true },
  { family: 'piston_knock', file: 'Piston.wav', reported: true },
  { family: 'misfire_detected_medium', file: 'misfire_detected_medium.wav', reported: true },
  { family: 'intake_leak', file: 'intake_leak_low.wav', reported: false },
];

const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/constellation_v1.json'), 'utf8'));
hydrateIndex(artifact);
const indexedFamilies = new Set(artifact.refs.map(r => r.fault_type));

const fp = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/fingerprints_v9.json'), 'utf8'));
const embedCensus = {};
for (const f of fp.faults || []) {
  const k = f.fault_type || f.family || f.label;
  embedCensus[k] = (embedCensus[k] || 0) + 1;
}

console.log('══ RCA — four reported families ══\n');
console.log(`Path A index: ${artifact.refs.length} references`);
console.log(`Path B index: ${(fp.faults || []).length} fault embeddings, ${(fp.anchors || []).length} anchors`);
console.log(`Gates: instant >=${MIN_COHERENT_SCORE}/${MIN_NORMALIZED_SCORE}  `
  + `sustained >=${SUSTAINED_COHERENT_SCORE}/${SUSTAINED_NORMALIZED_SCORE} x${SUSTAINED_REPEATS}\n`);

const rows = [];

for (const c of CASES) {
  let pcm;
  try { pcm = load(c.file); }
  catch (e) { console.log(`SKIP ${c.file} — ${e.message}`); continue; }

  // The bucket originals are 1-5 s. A live mic supplies continuous audio, and
  // the rolling matcher needs MIN_LISTEN_SECONDS (3 s) before it will try at
  // all — so a raw 1 s clip can never fire regardless of engine health. Loop
  // to a realistic scan length so this measures the ENGINE, not the fixture.
  const nativeSeconds = pcm.length / SR;
  if (nativeSeconds < LISTEN_SECONDS * 2) {
    pcm = extendByCrossfadeLoop(pcm, LISTEN_SECONDS * 2, SR);
  }

  // ── BASIC: Path A armed. Feed the clip through the rolling matcher exactly
  //    as startExtraction does — push every block, tryMatch on the same 900 ms
  //    cadence the extractor uses.
  const matcher = createRollingMatcher();
  const BLOCK = 4096;                       // the app's ScriptProcessor block
  const TRY_EVERY = Math.round(SR * 0.9);   // 900 ms cadence
  let fired = null, sincePush = 0, bestRolling = { score: 0, normalized: 0, ref: null };
  for (let off = 0; off + BLOCK <= pcm.length && !fired; off += BLOCK) {
    matcher.push(pcm.subarray(off, off + BLOCK));
    sincePush += BLOCK;
    if (sincePush < TRY_EVERY) continue;
    sincePush = 0;
    const m = matcher.tryMatch();
    if (!m) continue;
    if (m.score > bestRolling.score) bestRolling = m;
    if (m.matched) fired = m;
  }

  // Single-shot score over the whole clip, for visibility into how far a
  // non-firing clip actually sits from the gate.
  const best = matchHashes(computeConstellationHashes(pcm));

  rows.push({
    family: c.family,
    file: c.file,
    seconds: +nativeSeconds.toFixed(1),
    inPathA: indexedFamilies.has(c.family),
    fired: !!fired,
    firedAs: fired?.ref?.fault_type ?? null,
    firedVia: fired ? (fired.sustained && fired.score < MIN_COHERENT_SCORE ? 'sustained' : 'instant') : null,
    rollScore: bestRolling.score,
    rollNorm: +(bestRolling.normalized || 0).toFixed(4),
    score: best?.score ?? 0,
    norm: +(best?.normalized ?? 0).toFixed(4),
    matchedAs: best?.ref?.fault_type ?? null,
    embeddings: embedCensus[c.family] ?? 0,
  });
}

console.log('── BASIC (Path A armed) — rolling matcher, production cadence ──');
console.log('family                      file                              s    inA  fired  via       rollScore rollNorm  full  matched-as');
for (const r of rows) {
  console.log(
    `${r.family.padEnd(27)} ${r.file.slice(0, 32).padEnd(33)} ${String(r.seconds).padStart(4)} `
    + `${(r.inPathA ? 'yes' : 'NO ').padEnd(4)} ${(r.fired ? 'YES' : 'no ').padEnd(6)} `
    + `${(r.firedVia ?? '-').padEnd(9)} ${String(r.rollScore).padStart(9)} ${r.rollNorm.toFixed(4).padStart(8)} `
    + `${String(r.score).padStart(5)}  ${r.matchedAs ?? '-'}`);
}

console.log('\n── AI ENABLED (Path A NOT armed — isolation change) ──');
console.log('family                      pathA-available  pathB-embeddings');
for (const r of rows) {
  console.log(`${r.family.padEnd(27)} ${'none (disarmed)'.padEnd(16)} ${String(r.embeddings).padStart(4)}`);
}

console.log('\n── Verdict per family ──');
const seen = new Set();
for (const r of rows) {
  if (seen.has(r.family)) continue;
  seen.add(r.family);
  const all = rows.filter(x => x.family === r.family);
  const anyFired = all.some(x => x.fired);
  const basic = !r.inPathA ? 'NOT in Path A at all'
    : anyFired ? 'Path A fires' : 'Path A present but BELOW GATE';
  const ai = r.embeddings === 0 ? 'no Path B embeddings'
    : r.embeddings < 16 ? `THIN — only ${r.embeddings} embeddings`
    : `${r.embeddings} embeddings`;
  console.log(`${r.family.padEnd(27)} BASIC: ${basic.padEnd(30)} AI ENABLED: ${ai}`);
}
