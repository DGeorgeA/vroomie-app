/**
 * measure_near_match_tier.mjs — feasibility measurement for a 65-72%
 * "possible match" tier on the EMBEDDING path.
 *
 * Semantics: the app's published possibility is 70 + 108*(margin-0.04),
 * clamped to [70,97]. A 65-72% band therefore corresponds to margins just
 * BELOW the 0.04 confirm threshold. Candidate near-tier rule:
 *   window is a NEAR candidate if bestFault >= TAU and margin in [0.02, 0.04)
 *   session reports "possible <family>" if near+full candidates of one family
 *   >= FRACTION of accepted windows (same 0.45), when NOTHING was confirmed.
 *
 * Measures BOTH sides:
 *   cost   — how many of 140 held-out healthy clips would show a "possible"?
 *   value  — do the known acoustic misses (rocker@2m tie, alternator replay)
 *            get recovered as a correct "possible"?
 *   guard  — interferers (speech/music/fan/traffic) must not enter the tier.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const TAU = 0.45, MARGIN = 0.04, FRACTION = 0.45, MIN_ACCEPTED = 3;
// Parameterized by the offline sweep: the only corner with ZERO added healthy
// false alarms on the 35-session benchmark was near=0.02 at fraction 0.85.
const NEAR_MARGIN = parseFloat(process.env.NEAR_MARGIN || '0.02');
const NEAR_FRACTION = parseFloat(process.env.NEAR_FRACTION || '0.85');
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const TESTAUDIO = path.join(ROOT, 'scratch', 'testaudio');

const csv = fs.readFileSync(path.join(__dirname, 'yamnet_class_map.csv'), 'utf8');
const CLASSES = csv.trim().split('\n').slice(1).map(raw => {
  const line = raw.replace(/\r$/, '');
  const m = line.match(/^(\d+),([^,]+),(.*)$/);
  return m ? m[3].replace(/^"|"$/g, '') : line;
});
const VN = ['Vehicle', 'Motor vehicle (road)', 'Car', 'Vehicle horn, car horn, honking', 'Car alarm',
  'Power windows, electric windows', 'Skidding', 'Tire squeal', 'Car passing by', 'Race car, auto racing',
  'Truck', 'Air brake', 'Air horn, truck horn', 'Reversing beeps', 'Motorcycle', 'Traffic noise, roadway noise',
  'Engine', 'Light engine (high frequency)', 'Dental drill, dentist\'s drill', 'Lawn mower', 'Chainsaw',
  'Medium engine (mid frequency)', 'Heavy engine (low frequency)', 'Engine knocking', 'Engine starting',
  'Idling', 'Accelerating, revving, vroom', 'Machine gun', 'Tools', 'Hammer', 'Jackhammer', 'Sawing',
  'Filing (rasp)', 'Sanding', 'Power tool', 'Drill', 'Sewing machine', 'Vacuum cleaner',
  'Rattle', 'Whir', 'Clatter', 'Squeak', 'Gears', 'Grind', 'Clicking', 'Buzz', 'Hum', 'Rumble', 'Thump, thud',
  'Bang', 'Slap, smack', 'Whack, thwack', 'Crushing'];
const VEH = new Set(VN.map(n => CLASSES.indexOf(n)).filter(i => i >= 0));
const INTF = (() => {
  const s = new Set();
  const a = CLASSES.indexOf('Speech'), b = CLASSES.indexOf('Chatter');
  for (let i = a; i <= b && i >= 0; i++) s.add(i);
  const c = CLASSES.indexOf('Music'), d = CLASSES.indexOf('Song');
  for (let i = c; i <= d && i >= 0; i++) s.add(i);
  for (const n of ['Television', 'Radio', 'Silence', 'Whistling', 'Whistle']) { const i = CLASSES.indexOf(n); if (i >= 0) s.add(i); }
  return s;
})();
function decodeWav(buf) {
  let pos = 12, fmt = null, off = 0, len = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), sz = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    else if (id === 'data') { off = pos + 8; len = sz; }
    pos += 8 + sz + (sz % 2);
  }
  const n = fmt.bits === 16 ? len / 2 : len / 4;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = fmt.bits === 16 ? buf.readInt16LE(off + i * 2) / 32768 : buf.readFloatLE(off + i * 4);
  let m = x;
  if (fmt.ch > 1) { m = new Float32Array(Math.floor(n / fmt.ch)); for (let i = 0; i < m.length; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += x[i * fmt.ch + c]; m[i] = s / fmt.ch; } }
  return { pcm: m, rate: fmt.rate };
}
function rs(p, f) { if (f === SR) return p; const r = f / SR, o = new Float32Array(Math.floor(p.length / r)); for (let i = 0; i < o.length; i++) { const s = i * r, i0 = Math.floor(s), fr = s - i0; o[i] = (p[i0] || 0) * (1 - fr) + (p[i0 + 1] || 0) * fr; } return o; }
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12); };
const norm = (p, t = 0.05) => { const r = rmsOf(p); if (r < 1e-6) return p; const g = t / r, o = new Float32Array(p.length); for (let i = 0; i < p.length; i++) o[i] = Math.max(-1, Math.min(1, p[i] * g)); return o; };
const loopTo = (p, sec) => { const need = SR * sec; if (p.length >= need) return p.subarray(0, need); const o = new Float32Array(need); for (let i = 0; i < need; i++) o[i] = p[i % p.length]; return o; };
function biquad(sig, b0, b1, b2, a1, a2) { const out = new Float32Array(sig.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < sig.length; i++) { const x0 = sig[i]; const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0; } return out; }
function bandpass(pcm, hp, lp, q = 1.4) {
  const hw = 2 * Math.PI * hp / SR, ha = Math.sin(hw) / q, hc = Math.cos(hw);
  let a0 = 1 + ha;
  let s = biquad(pcm, (1 + hc) / 2 / a0, -(1 + hc) / a0, (1 + hc) / 2 / a0, -2 * hc / a0, (1 - ha) / a0);
  const lw = 2 * Math.PI * lp / SR, la = Math.sin(lw) / q, lc = Math.cos(lw);
  a0 = 1 + la;
  return biquad(s, (1 - lc) / 2 / a0, (1 - lc) / a0, (1 - lc) / 2 / a0, -2 * lc / a0, (1 - la) / a0);
}
function mulberry32(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function replayChannel(pcm, distanceM = 1.0, seed = 7) {
  const rnd = mulberry32(seed);
  let s = bandpass(pcm, 250, 7500);
  const out = new Float32Array(s.length);
  const d1 = Math.floor(SR * 0.013), d2 = Math.floor(SR * 0.027);
  const refl = Math.min(0.45, 0.18 * distanceM + 0.12);
  for (let i = 0; i < s.length; i++) out[i] = s[i] + refl * (i > d1 ? s[i - d1] : 0) + (refl * 0.55) * (i > d2 ? s[i - d2] : 0);
  const atten = 1 / (1 + 0.9 * distanceM), noiseAmp = 0.0016 * distanceM;
  for (let i = 0; i < out.length; i++) out[i] = out[i] * atten + (rnd() * 2 - 1) * noiseAmp;
  return out;
}

const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'fingerprints_v9.json'), 'utf8'));
const dq = q => { const b = Buffer.from(q.b64, 'base64'); const o = new Float32Array(b.length); for (let i = 0; i < b.length; i++) o[i] = q.min + b[i] * q.scale; return o; };
const F = art.faults.map(f => ({ fam: f.fault_type || f.label, emb: dq(f.q) }));
const A = art.anchors.map(a => dq(a.q));
function gate(sc) {
  let t1 = 0, veh = 0, intf = 0;
  for (let i = 0; i < sc.length; i++) { if (sc[i] > sc[t1]) t1 = i; if (VEH.has(i) && sc[i] > veh) veh = sc[i]; if (INTF.has(i) && sc[i] > intf) intf = sc[i]; }
  const isIntf = INTF.has(t1);
  return VEH.has(t1) || (!isIntf && intf < 0.15) || (veh >= 0.03 && veh > intf) || (isIntf && veh >= 0.02 && intf <= 0.30);
}
/** Session outcome under shipped rules + candidate NEAR tier. */
function run(pcm) {
  const sess = loopTo(pcm, 12);
  let accepted = 0;
  const full = new Map(), near = new Map();
  for (let off = 0; off + WIN <= sess.length; off += WIN) {
    const w = sess.subarray(off, off + WIN);
    if (rmsOf(w) < 0.005) continue;
    const { sc, emb } = tf.tidy(() => {
      const [scores, embeddings] = model.predict(tf.tensor1d(norm(w)));
      return { sc: Array.from(tf.mean(scores, 0).dataSync()), emb: Array.from(tf.mean(embeddings, 0).dataSync()) };
    });
    if (!gate(sc)) continue;
    accepted++;
    let bf = -1, bfam = null;
    for (const f of F) { const c = cos(emb, f.emb); if (c > bf) { bf = c; bfam = f.fam; } }
    let ba = 0;
    for (const a of A) { const c = cos(emb, a); if (c > ba) ba = c; }
    const margin = bf - ba;
    if (bf >= TAU && margin >= MARGIN) full.set(bfam, (full.get(bfam) || 0) + 1);
    else if (bf >= TAU && margin >= NEAR_MARGIN) near.set(bfam, (near.get(bfam) || 0) + 1);
  }
  // shipped confirm (primary only is enough for this study)
  let confirmed = null;
  if (accepted >= MIN_ACCEPTED) for (const [f, h] of full) if (h / accepted >= FRACTION) confirmed = f;
  // NEAR tier: full+near of one family >= FRACTION, only when nothing confirmed
  let possible = null, possibleFrac = 0;
  if (!confirmed && accepted >= MIN_ACCEPTED) {
    const fams = new Set([...full.keys(), ...near.keys()]);
    for (const f of fams) {
      const h = (full.get(f) || 0) + (near.get(f) || 0);
      const fr = h / accepted;
      if (fr >= NEAR_FRACTION && fr > possibleFrac) { possible = f; possibleFrac = fr; }
    }
  }
  return { accepted, confirmed, possible, possibleFrac: +possibleFrac.toFixed(2) };
}

console.log('=== VALUE: known acoustic misses — does the near tier recover them? ===');
const MISSES = [
  ['RockerArmAndValve.wav', 2.0, 'rocker_valve'],
  ['alternator_bearing_fault_critical.wav', 1.0, 'alternator_bearing_fault'],
  ['MotorStarter.wav', 2.0, 'motor_starter'],
];
for (const [file, dist, expect] of MISSES) {
  const buf = Buffer.from(await (await fetch(BUCKET + encodeURIComponent(file))).arrayBuffer());
  const p = rs(decodeWav(buf).pcm, decodeWav(buf).rate);
  const r = run(replayChannel(p, dist, 7));
  console.log(`  ${file.slice(0, 38).padEnd(40)} confirmed=${r.confirmed || '-'} possible=${r.possible || '-'} (frac ${r.possibleFrac}) expect=${expect}`);
}

console.log('\n=== GUARD: interferers must not enter the tier ===');
function synth(kind) {
  const n = SR * 12, out = new Float32Array(n), rnd = mulberry32(11);
  if (kind === 'fan') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.995 * lp + 0.005 * (rnd() * 2 - 1); out[i] = lp * 6 + 0.004 * Math.sin(2 * Math.PI * 48 * i / SR); } }
  else if (kind === 'traffic') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.9985 * lp + 0.0015 * (rnd() * 2 - 1); out[i] = lp * 9 + 0.02 * Math.sin(2 * Math.PI * 90 * i / SR); } }
  else if (kind === 'white') { for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.08; }
  else { const notes = [261.6, 329.6, 392.0, 523.3]; for (let i = 0; i < n; i++) { const t = i / SR, f = notes[Math.floor(t * 2) % 4]; out[i] = 0.16 * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t)); } }
  return out;
}
for (const k of ['fan', 'traffic', 'white', 'music']) {
  const r = run(synth(k));
  console.log(`  ${k.padEnd(10)} confirmed=${r.confirmed || '-'} possible=${r.possible || '-'} (frac ${r.possibleFrac})`);
}
for (const f of fs.readdirSync(TESTAUDIO).filter(x => /\.wav$/i.test(x))) {
  const d = decodeWav(fs.readFileSync(path.join(TESTAUDIO, f)));
  const r = run(rs(d.pcm, d.rate));
  console.log(`  ${f.padEnd(26)} confirmed=${r.confirmed || '-'} possible=${r.possible || '-'}`);
}

console.log('\n=== COST: 140 held-out healthy clips ===');
let hN = 0, hConf = 0, hPoss = 0;
const possDetail = [];
for (const [lbl, sub] of [['idle', path.join(DATASET, 'idle state', 'normal_engine_idle')],
                          ['startup', path.join(DATASET, 'startup state', 'normal_engine_startup')],
                          ['brakes', path.join(DATASET, 'braking state', 'normal_brakes')]]) {
  if (!fs.existsSync(sub)) continue;
  for (const f of fs.readdirSync(sub).filter(f => /\.wav$/i.test(f)).filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === 1; }).sort((a, b) => +a.match(/_(\d+)\.wav$/)[1] - +b.match(/_(\d+)\.wav$/)[1]).slice(0, 70)) {
    try {
      const d = decodeWav(fs.readFileSync(path.join(sub, f)));
      const r = run(rs(d.pcm, d.rate));
      hN++;
      if (r.confirmed) hConf++;
      else if (r.possible) { hPoss++; possDetail.push(`${lbl}/${f}->${r.possible}(${r.possibleFrac})`); }
    } catch {}
  }
}
console.log(`  clips=${hN} | confirmed FP=${hConf} | ADDITIONAL "possible" FP=${hPoss} (${(100 * hPoss / Math.max(hN, 1)).toFixed(1)}%)`);
possDetail.slice(0, 20).forEach(x => console.log('   ', x));
console.log('\nDONE');
