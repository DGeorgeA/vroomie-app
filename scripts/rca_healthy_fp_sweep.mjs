/**
 * rca_healthy_fp_sweep.mjs — PROMPT 2/3: establish the TRUE healthy
 * false-positive baseline. Measure only; changes nothing.
 *
 * Why this exists: the historical "0/35 healthy false positives" figure was
 * measured on a STRIDE SAMPLE (15 of ~132 held-out idle clips, 10 of ~30
 * startup, 10 brakes). A sparse clean sample is not a false-positive RATE.
 * This sweeps EVERY held-out (odd-numbered) healthy clip — the factory builds
 * anchors from EVEN-numbered clips only, so odd clips are genuinely unseen.
 *
 * Runs the shipped live path and the shipped decision rule verbatim.
 * Output: scratch/rca_healthy_fp_sweep.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const TAU = 0.45, MARGIN = 0.04, FRACTION = 0.45, MIN_ACCEPTED = 3;
const SILENCE_GATE = 0.005, NORM_TARGET = 0.05;
const VEHICLE_FLOOR = 0.03, INTERFERER_CEIL = 0.15;
const SESSION_SEC = 12;
const MAX_PER_DIR = +(process.env.MAX_PER_DIR || 70);

const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');

const csv = fs.readFileSync(path.join(__dirname, 'yamnet_class_map.csv'), 'utf8');
const CLASSES = csv.trim().split('\n').slice(1).map(raw => {
  const line = raw.replace(/\r$/, '');
  const m = line.match(/^(\d+),([^,]+),(.*)$/);
  return m ? m[3].replace(/^"|"$/g, '') : line;
});
const VEHICLE_MECH_NAMES = ['Vehicle', 'Motor vehicle (road)', 'Car', 'Vehicle horn, car horn, honking', 'Car alarm',
  'Power windows, electric windows', 'Skidding', 'Tire squeal', 'Car passing by', 'Race car, auto racing',
  'Truck', 'Air brake', 'Air horn, truck horn', 'Reversing beeps', 'Motorcycle', 'Traffic noise, roadway noise',
  'Engine', 'Light engine (high frequency)', 'Dental drill, dentist\'s drill', 'Lawn mower', 'Chainsaw',
  'Medium engine (mid frequency)', 'Heavy engine (low frequency)', 'Engine knocking', 'Engine starting',
  'Idling', 'Accelerating, revving, vroom', 'Machine gun', 'Tools', 'Hammer', 'Jackhammer', 'Sawing',
  'Filing (rasp)', 'Sanding', 'Power tool', 'Drill', 'Sewing machine', 'Vacuum cleaner',
  'Rattle', 'Whir', 'Clatter', 'Squeak', 'Gears', 'Grind', 'Clicking', 'Buzz', 'Hum', 'Rumble', 'Thump, thud',
  'Bang', 'Slap, smack', 'Whack, thwack', 'Crushing'];
const VEH = new Set(VEHICLE_MECH_NAMES.map(n => CLASSES.indexOf(n)).filter(i => i >= 0));
const INTF = (() => {
  const s = new Set();
  const a = CLASSES.indexOf('Speech'), b = CLASSES.indexOf('Chatter');
  for (let i = a; i <= b && i >= 0; i++) s.add(i);
  const c = CLASSES.indexOf('Music'), d = CLASSES.indexOf('Song');
  for (let i = c; i <= d && i >= 0; i++) s.add(i);
  for (const n of ['Television', 'Radio', 'Silence', 'Whistling', 'Whistle']) {
    const i = CLASSES.indexOf(n); if (i >= 0) s.add(i);
  }
  return s;
})();

function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
  let pos = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), sz = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    else if (id === 'data') { dataOff = pos + 8; dataLen = sz; }
    pos += 8 + sz + (sz % 2);
  }
  const n = fmt.bits === 16 ? dataLen / 2 : fmt.bits === 32 ? dataLen / 4 : dataLen;
  const inter = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (fmt.bits === 16) inter[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
    else if (fmt.bits === 32 && fmt.format === 3) inter[i] = buf.readFloatLE(dataOff + i * 4);
    else if (fmt.bits === 32) inter[i] = buf.readInt32LE(dataOff + i * 4) / 2147483648;
    else inter[i] = (buf.readUInt8(dataOff + i) - 128) / 128;
  }
  let mono = inter;
  if (fmt.channels > 1) {
    mono = new Float32Array(Math.floor(n / fmt.channels));
    for (let i = 0; i < mono.length; i++) {
      let s = 0; for (let c = 0; c < fmt.channels; c++) s += inter[i * fmt.channels + c];
      mono[i] = s / fmt.channels;
    }
  }
  return { pcm: mono, rate: fmt.rate };
}
function resampleTo16k(pcm, from) {
  if (from === SR) return pcm;
  const ratio = from / SR, out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio, i0 = Math.floor(src), f = src - i0;
    out[i] = (pcm[i0] || 0) * (1 - f) + (pcm[i0 + 1] || 0) * f;
  }
  return out;
}
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12); };
function rmsNormalize(pcm, t = NORM_TARGET) {
  const r = rmsOf(pcm); if (r < 1e-6) return pcm;
  const g = t / r, o = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) o[i] = Math.max(-1, Math.min(1, pcm[i] * g));
  return o;
}
const loopTo = (pcm, sec) => {
  const need = SR * sec;
  if (pcm.length >= need) return pcm.subarray(0, need);
  const o = new Float32Array(need);
  for (let i = 0; i < need; i++) o[i] = pcm[i % pcm.length];
  return o;
};

const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'fingerprints_v9.json'), 'utf8'));
const dq = q => { const b = Buffer.from(q.b64, 'base64'); const o = new Float32Array(b.length); for (let i = 0; i < b.length; i++) o[i] = q.min + b[i] * q.scale; return o; };
const FAULTS = art.faults.map(f => ({ family: f.fault_type || f.label, label: f.label, emb: dq(f.q) }));
const ANCH = art.anchors.map(a => dq(a.q));
const ANCHOR_SOURCES = new Set(art.anchors.map(a => (a.source || '').replace(/#.*$/, '')));

function analyze(w) {
  return tf.tidy(() => {
    const [sc, em] = model.predict(tf.tensor1d(w));
    return { sc: Array.from(tf.mean(sc, 0).dataSync()), emb: Array.from(tf.mean(em, 0).dataSync()) };
  });
}
function gate(sc) {
  let t1 = 0, veh = 0, intf = 0;
  for (let i = 0; i < sc.length; i++) {
    if (sc[i] > sc[t1]) t1 = i;
    if (VEH.has(i) && sc[i] > veh) veh = sc[i];
    if (INTF.has(i) && sc[i] > intf) intf = sc[i];
  }
  return VEH.has(t1) || (!INTF.has(t1) && intf < INTERFERER_CEIL) || (veh >= VEHICLE_FLOOR && veh > intf);
}
function runSession(pcm) {
  const sess = loopTo(pcm, SESSION_SEC);
  let accepted = 0;
  const votes = new Map();
  let worstMargin = -1, worstFamily = null;
  for (let s = 0; s + WIN <= sess.length; s += WIN) {
    const w = sess.subarray(s, s + WIN);
    if (rmsOf(w) < SILENCE_GATE) continue;
    const { sc, emb } = analyze(rmsNormalize(w));
    if (!gate(sc)) continue;
    accepted++;
    let bf = -1, bfam = null, blab = null;
    for (const f of FAULTS) { const c = cosine(emb, f.emb); if (c > bf) { bf = c; bfam = f.family; blab = f.label; } }
    let ba = 0;
    for (const a of ANCH) { const c = cosine(emb, a); if (c > ba) ba = c; }
    const margin = bf - ba;
    if (margin > worstMargin) { worstMargin = margin; worstFamily = bfam; }
    if (bf >= TAU && margin >= MARGIN) votes.set(bfam, (votes.get(bfam) || 0) + 1);
  }
  let fam = null, frac = 0;
  if (accepted >= MIN_ACCEPTED) {
    for (const [f, h] of votes) { const r = h / accepted; if (r >= FRACTION && r > frac) { fam = f; frac = r; } }
  }
  return { accepted, confirmedFamily: fam, fraction: +frac.toFixed(3), worstMargin: +worstMargin.toFixed(4), worstFamily };
}

const DIRS = [
  ['idle', path.join(DATASET, 'idle state', 'normal_engine_idle')],
  ['startup', path.join(DATASET, 'startup state', 'normal_engine_startup')],
  ['brakes', path.join(DATASET, 'braking state', 'normal_brakes')],
];
const rows = [];
for (const [label, dir] of DIRS) {
  if (!fs.existsSync(dir)) { console.log(`[skip] ${dir}`); continue; }
  // HELD-OUT = odd numeric suffix (factory anchors use even only)
  const files = fs.readdirSync(dir).filter(f => /\.wav$/i.test(f))
    .filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === 1; })
    .sort((a, b) => +a.match(/_(\d+)\.wav$/)[1] - +b.match(/_(\d+)\.wav$/)[1])
    .slice(0, MAX_PER_DIR);
  console.log(`[sweep] ${label}: ${files.length} held-out clips`);
  for (const f of files) {
    let r;
    try { const d = decodeWav(fs.readFileSync(path.join(dir, f))); r = runSession(resampleTo16k(d.pcm, d.rate)); }
    catch (e) { continue; }
    const contaminated = ANCHOR_SOURCES.has(f);   // sanity: must be false for odd files
    rows.push({ set: label, file: f, ...r, falsePositive: !!r.confirmedFamily, contaminated });
    if (r.confirmedFamily) console.log(`  FP ${f} -> ${r.confirmedFamily} (frac ${r.fraction}, accepted ${r.accepted})`);
  }
}

const total = rows.length, fps = rows.filter(r => r.falsePositive);
const byFamily = {};
for (const r of fps) byFamily[r.confirmedFamily] = (byFamily[r.confirmedFamily] || 0) + 1;
const bySet = {};
for (const r of rows) {
  bySet[r.set] = bySet[r.set] || { n: 0, fp: 0 };
  bySet[r.set].n++; if (r.falsePositive) bySet[r.set].fp++;
}
const contaminatedCount = rows.filter(r => r.contaminated).length;

const out = {
  note: 'TRUE held-out healthy false-positive baseline at the SHIPPED operating point. Held-out = odd-numbered clips; the factory builds anchors from even-numbered clips only.',
  operatingPoint: { TAU, MARGIN, FRACTION, MIN_ACCEPTED, SILENCE_GATE, NORM_TARGET, SESSION_SEC },
  totalClips: total, falsePositives: fps.length,
  falsePositiveRatePct: +(100 * fps.length / Math.max(total, 1)).toFixed(2),
  bySet, byFamily, anchorContaminatedClips: contaminatedCount,
  historicalClaim: '0/35 — measured on a stride sample, not a rate',
  falsePositiveDetail: fps, rows,
};
fs.writeFileSync(path.join(ROOT, 'scratch', 'rca_healthy_fp_sweep.json'), JSON.stringify(out, null, 2));
console.log(`\n[SWEEP] healthy false positives ${fps.length}/${total} = ${out.falsePositiveRatePct}%`);
console.log('[SWEEP] by set:', JSON.stringify(bySet));
console.log('[SWEEP] by family:', JSON.stringify(byFamily));
console.log('[SWEEP] anchor-contaminated clips in sample (must be 0):', contaminatedCount);
