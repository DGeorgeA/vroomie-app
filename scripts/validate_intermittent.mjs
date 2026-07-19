/**
 * validate_intermittent.mjs — BMAD cycle for the HUMAN test pattern.
 *
 * Real live validation is "tap play on a 2 s sample, pause, tap again" — NOT the
 * continuous loops previous harnesses used. This script:
 *   BREAK   — simulates intermittent replay (clip + inter-play gap) through the
 *             speaker→room→mic channel; the current ≥50%-fraction session rule
 *             is expected to MISS (anomaly windows are diluted by gap windows).
 *   MEASURE — candidate-hit distributions for LONG (60 s) healthy/negative
 *             sessions, which bound how weak a secondary rule can be at 0 FP.
 *   DECIDE  — evaluates a grid of secondary confirmation rules
 *             (absolute hits N + relaxed fraction f) on both sides.
 *
 * Usage: node scripts/validate_intermittent.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const TAU = 0.60, MARGIN = 0.05;
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');

// ─── class map + gate (identical to production v9.3) ────────────────
const csv = fs.readFileSync(path.join(__dirname, 'yamnet_class_map.csv'), 'utf8');
const CLASSES = csv.trim().split('\n').slice(1).map(raw => {
  const l = raw.replace(/\r$/, '');
  const m = l.match(/^\d+,[^,]+,(.*)$/);
  let n = m[1].trim();
  if (n.startsWith('"') && n.endsWith('"')) n = n.slice(1, -1);
  return n;
});
const VEHICLE_MECH_NAMES = ['Vehicle', 'Motor vehicle (road)', 'Car', 'Vehicle horn, car horn, honking', 'Car alarm',
  'Power windows, electric windows', 'Skidding', 'Tire squeal', 'Car passing by', 'Race car, auto racing', 'Truck',
  'Air brake', 'Air horn, truck horn', 'Reversing beeps', 'Bus', 'Motorcycle', 'Traffic noise, roadway noise',
  'Engine', 'Light engine (high frequency)', 'Medium engine (mid frequency)', 'Heavy engine (low frequency)',
  'Engine knocking', 'Engine starting', 'Idling', 'Accelerating, revving, vroom', 'Lawn mower', 'Chainsaw',
  'Mechanisms', 'Ratchet, pawl', 'Gears', 'Pulleys', 'Sewing machine', 'Tools', 'Hammer', 'Jackhammer', 'Sawing',
  'Power tool', 'Drill', 'Rattle', 'Squeak', 'Squeal', 'Whir', 'Hum', 'Vibration', 'Throbbing', 'Rumble',
  'Clicking', 'Tick', 'Clatter', 'Creak', 'Scrape', 'Grind'];
const VEH = new Set(VEHICLE_MECH_NAMES.map(n => CLASSES.indexOf(n)).filter(i => i >= 0));
const INTF = (() => {
  const s = new Set();
  for (let i = 0; i < CLASSES.indexOf('Animal'); i++) s.add(i);
  for (let i = CLASSES.indexOf('Music'); i < CLASSES.indexOf('Wind'); i++) s.add(i);
  ['Television', 'Radio', 'Silence', 'Whistling', 'Whistle'].forEach(n => { const i = CLASSES.indexOf(n); if (i >= 0) s.add(i); });
  return s;
})();

// ─── DSP (identical to prior harnesses) ─────────────────────────────
function decodeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(pos + 8, true), channels: dv.getUint16(pos + 10, true), sampleRate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
    else if (id === 'data') { dataOff = pos + 8; dataLen = size; }
    pos += 8 + size + (size % 2);
  }
  const bytesPer = fmt.bits / 8;
  const frames = Math.floor(Math.min(dataLen, dv.byteLength - dataOff) / (bytesPer * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const off = dataOff + (i * fmt.channels + c) * bytesPer;
      let v;
      if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(off, true);
      else if (fmt.bits === 16) v = dv.getInt16(off, true) / 32768;
      else v = dv.getInt32(off, true) / 2147483648;
      acc += v;
    }
    out[i] = acc / fmt.channels;
  }
  if (fmt.sampleRate === SR) return out;
  const ratio = fmt.sampleRate / SR, outLen = Math.floor(out.length / ratio);
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio, l = Math.floor(x), r = Math.min(l + 1, out.length - 1);
    res[i] = out[l] * (1 - (x - l)) + out[r] * (x - l);
  }
  return res;
}
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
const cosine = (a, b) => {
  let d = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
  return (nA === 0 || nB === 0) ? 0 : d / (Math.sqrt(nA) * Math.sqrt(nB));
};
function biquad(sig, b0, b1, b2, a1, a2) {
  const out = new Float32Array(sig.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const x0 = sig[i], y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}
function bandpass(pcm, hpHz, lpHz) {
  const wH = 2 * Math.PI * hpHz / SR, cH = Math.cos(wH), sH = Math.sin(wH) / 1.414, a0H = 1 + sH;
  let s = biquad(pcm, (1 + cH) / 2 / a0H, -(1 + cH) / a0H, (1 + cH) / 2 / a0H, -2 * cH / a0H, (1 - sH) / a0H);
  const wL = 2 * Math.PI * lpHz / SR, cL = Math.cos(wL), sL = Math.sin(wL) / 1.414, a0L = 1 + sL;
  return biquad(s, (1 - cL) / 2 / a0L, (1 - cL) / a0L, (1 - cL) / 2 / a0L, -2 * cL / a0L, (1 - sL) / a0L);
}
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function replayChannel(pcm, seed = 7) {
  let s = bandpass(pcm, 300, 8000);
  const e1 = Math.floor(SR * 0.025), e2 = Math.floor(SR * 0.060);
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] + (i >= e1 ? s[i - e1] * 0.25 : 0) + (i >= e2 ? s[i - e2] * 0.15 : 0);
  const rnd = mulberry32(seed);
  const nR = rmsOf(out) / Math.pow(10, 25 / 20);
  for (let i = 0; i < out.length; i++) out[i] += (rnd() * 2 - 1) * nR * 1.732;
  const g = 0.05 / Math.max(1e-6, rmsOf(out));
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * g * 1.5) / 1.5;
  return out;
}
function rmsNormalize(pcm, target = 0.05) {
  const r = rmsOf(pcm);
  if (r < 1e-6) return pcm;
  const g = target / r;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i] * g));
  return out;
}
// Human test pattern: play clip, pause with room tone, repeat
function intermittent(clip, gapSec, totalSec, roomAmp = 0.006, seed = 5) {
  const out = new Float32Array(SR * totalSec);
  const rnd = mulberry32(seed);
  for (let i = 0; i < out.length; i++) out[i] = (rnd() * 2 - 1) * roomAmp; // room tone floor
  const cycle = clip.length + Math.floor(SR * gapSec);
  for (let start = 0; start + clip.length <= out.length; start += cycle) {
    for (let i = 0; i < clip.length; i++) out[start + i] += clip[i];
  }
  return out;
}
const loopTo = (pcm, sec) => {
  const out = new Float32Array(SR * sec);
  for (let i = 0; i < out.length; i++) out[i] = pcm[i % pcm.length];
  return out;
};

// ─── model + artifact ───────────────────────────────────────────────
console.log('[BMAD] Loading YAMNet + artifact…');
const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'fingerprints_v9.json'), 'utf8'));
const dq = (q) => {
  const b = Buffer.from(q.b64, 'base64');
  const o = new Float32Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = q.min + b[i] * q.scale;
  return o;
};
const FAULTS = art.faults.map(f => ({ label: f.label, emb: dq(f.q) }));
const ANCH = art.anchors.map(a => dq(a.q));

function analyze(w) {
  return tf.tidy(() => {
    const [scores, embeddings] = model.predict(tf.tensor1d(w));
    return { emb: Array.from(tf.mean(embeddings, 0).dataSync()), sc: Array.from(tf.mean(scores, 0).dataSync()) };
  });
}
function gate(sc) {
  let t1 = 0, veh = 0, intf = 0;
  for (let i = 0; i < sc.length; i++) {
    if (sc[i] > sc[t1]) t1 = i;
    if (VEH.has(i) && sc[i] > veh) veh = sc[i];
    if (INTF.has(i) && sc[i] > intf) intf = sc[i];
  }
  return VEH.has(t1) || (!INTF.has(t1) && intf < 0.15) || (veh >= 0.03 && veh > intf);
}
// Measure a session exactly like the v9.3 live path; return per-window facts
function measure(pcm) {
  const wins = [];
  for (let s = 0; s + WIN <= pcm.length; s += WIN) {
    const w = pcm.slice(s, s + WIN);
    if (rmsOf(w) < 0.005) { wins.push({ kind: 'rej' }); continue; }
    const { emb, sc } = analyze(rmsNormalize(w));
    if (!gate(sc)) { wins.push({ kind: 'rej' }); continue; }
    let bf = -1, bl = null;
    for (const f of FAULTS) { const c = cosine(emb, f.emb); if (c > bf) { bf = c; bl = f.label; } }
    let ba = 0;
    for (const a of ANCH) { const c = cosine(emb, a); if (c > ba) ba = c; }
    wins.push({ kind: (bf >= TAU && (bf - ba) >= MARGIN) ? 'cand' : 'clean', label: bl });
  }
  return wins;
}
// Session rules
function decideCurrent(wins) { // shipped v9.3: fraction >= 0.5, min 4 accepted
  const per = new Map();
  let accepted = 0;
  for (const w of wins) {
    if (w.kind === 'rej') continue;
    accepted++;
    if (w.kind === 'cand') per.set(w.label, (per.get(w.label) || 0) + 1);
  }
  const out = new Set();
  for (const [l, c] of per) if (accepted >= 4 && c / accepted >= 0.5) out.add(l);
  return out;
}
function decideHybrid(minAbs, fracLo) { // fraction 0.5 OR (>= minAbs hits AND >= fracLo)
  return (wins) => {
    const per = new Map();
    let accepted = 0;
    for (const w of wins) {
      if (w.kind === 'rej') continue;
      accepted++;
      if (w.kind === 'cand') per.set(w.label, (per.get(w.label) || 0) + 1);
    }
    const out = new Set();
    for (const [l, c] of per) {
      if (accepted >= 4 && (c / accepted >= 0.5 || (c >= minAbs && c / accepted >= fracLo))) out.add(l);
    }
    return out;
  };
}

// ─── BREAK: intermittent replay of the benchmark + key anomalies ────
console.log('\n════ BREAK/MEASURE — intermittent human test pattern (clip + gap) ════');
const testRefs = ['BearingAlternator.wav', 'alternator_bearing_fault_critical.wav', 'PowerSteeringPump.wav', 'SerpentineBelt.wav', 'Piston.wav', 'timing_chain_rattle_high.wav'];
const posSessions = [];
for (const f of testRefs) {
  const res = await fetch(BUCKET + encodeURIComponent(f));
  if (!res.ok) continue;
  const clip = replayChannel(decodeWav(Buffer.from(await res.arrayBuffer())));
  for (const gap of [2, 4]) {
    const wins = measure(intermittent(clip, gap, 25));
    const cands = wins.filter(w => w.kind === 'cand').length;
    const acc = wins.filter(w => w.kind !== 'rej').length;
    posSessions.push({ name: `${f} gap=${gap}s`, wins, label: 'pos' });
    console.log(`  ${f.padEnd(46)} gap=${gap}s  candidates ${cands}/${acc} accepted  currentRule=${decideCurrent(wins).size ? 'DETECT' : 'MISS'}`);
  }
}

// ─── MEASURE: long healthy/negative sessions (bounds for the secondary rule) ──
console.log('\n════ MEASURE — long (60 s) healthy/negative candidate distributions ════');
function pick(dir, n, parity) {
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.wav'))
    .filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === parity; })
    .sort((a, b) => +a.match(/_(\d+)\.wav$/)[1] - +b.match(/_(\d+)\.wav$/)[1]);
  const step = Math.max(1, Math.floor(all.length / n));
  return all.filter((_, i) => i % step === 0).slice(0, n).map(f => path.join(dir, f));
}
const negSessions = [];
const healthySets = [
  [path.join(DATASET, 'idle state', 'normal_engine_idle'), 10],
  [path.join(DATASET, 'startup state', 'normal_engine_startup'), 5],
  [path.join(DATASET, 'braking state', 'normal_brakes'), 5],
];
let maxHealthyCand = 0;
for (const [dir, n] of healthySets) {
  for (const p of pick(dir, n, 1)) {
    const wins = measure(loopTo(decodeWav(fs.readFileSync(p)), 60));
    const cands = wins.filter(w => w.kind === 'cand').length;
    if (cands > maxHealthyCand) maxHealthyCand = cands;
    negSessions.push({ name: path.basename(p), wins, label: 'neg' });
    if (cands > 0) console.log(`  ${path.basename(p).padEnd(34)} 60s: ${cands} candidate windows`);
  }
}
{ // long ambient + fan negatives
  const rnd = mulberry32(11);
  const amb = new Float32Array(SR * 60);
  for (let i = 0; i < amb.length; i++) amb[i] = (rnd() * 2 - 1) * 0.05;
  negSessions.push({ name: 'ambient 60s', wins: measure(amb), label: 'neg' });
  const fan = new Float32Array(SR * 60);
  let y = 0;
  for (let i = 0; i < fan.length; i++) { const t = i / SR; y = 0.95 * y + 0.05 * (rnd() * 2 - 1); fan[i] = 0.035 * Math.sin(2 * Math.PI * 120 * t) + y * 0.45; }
  negSessions.push({ name: 'fan 60s', wins: measure(fan), label: 'neg' });
}
console.log(`  max candidate windows in any 60 s healthy/negative session: ${maxHealthyCand}`);

// ─── DECIDE — rule grid on both sides ───────────────────────────────
console.log('\n════ DECIDE — secondary-confirmation grid (fraction 0.5 OR abs+fracLo) ════');
console.log('rule                     | posDetect | negFP');
for (const [abs, fl] of [[4, 0.2], [5, 0.2], [5, 0.25], [6, 0.2], [6, 0.25], [6, 0.3], [8, 0.2], [8, 0.25]]) {
  const rule = decideHybrid(abs, fl);
  let pd = 0, nf = 0;
  for (const s of posSessions) if (rule(s.wins).size) pd++;
  for (const s of negSessions) if (rule(s.wins).size) nf++;
  console.log(`abs>=${abs} fracLo=${fl}`.padEnd(25) + `| ${String(pd).padStart(4)}/${posSessions.length}   | ${nf}/${negSessions.length}`);
}
// current rule on the same sets
{
  let pd = 0, nf = 0;
  for (const s of posSessions) if (decideCurrent(s.wins).size) pd++;
  for (const s of negSessions) if (decideCurrent(s.wins).size) nf++;
  console.log(`CURRENT (frac 0.5 only)`.padEnd(25) + `| ${String(pd).padStart(4)}/${posSessions.length}   | ${nf}/${negSessions.length}`);
}
console.log('\nBMAD MEASUREMENT COMPLETE');
