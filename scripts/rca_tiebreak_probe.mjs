/**
 * rca_tiebreak_probe.mjs — Prompt 3 pre-implementation measurement.
 * For the three tied sessions found in the RCA, capture per-family
 * {hits, marginSum, simSum} so the tie-break design is chosen from data.
 * Measure only.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const TAU = 0.45, MARGIN = 0.04;
const NORM_TARGET = 0.05, SESSION_SEC = 12;
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';

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
  for (const n of ['Television', 'Radio', 'Silence', 'Whistling', 'Whistle']) { const i = CLASSES.indexOf(n); if (i >= 0) s.add(i); }
  return s;
})();

function decodeWav(buf) {
  let pos = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), sz = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    else if (id === 'data') { dataOff = pos + 8; dataLen = sz; }
    pos += 8 + sz + (sz % 2);
  }
  const n = fmt.bits === 16 ? dataLen / 2 : dataLen / 4;
  const inter = new Float32Array(n);
  for (let i = 0; i < n; i++) inter[i] = fmt.bits === 16 ? buf.readInt16LE(dataOff + i * 2) / 32768 : buf.readFloatLE(dataOff + i * 4);
  let mono = inter;
  if (fmt.channels > 1) {
    mono = new Float32Array(Math.floor(n / fmt.channels));
    for (let i = 0; i < mono.length; i++) { let s = 0; for (let c = 0; c < fmt.channels; c++) s += inter[i * fmt.channels + c]; mono[i] = s / fmt.channels; }
  }
  return { pcm: mono, rate: fmt.rate };
}
function resampleTo16k(pcm, from) {
  if (from === SR) return pcm;
  const ratio = from / SR, out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) { const s = i * ratio, i0 = Math.floor(s), f = s - i0; out[i] = (pcm[i0] || 0) * (1 - f) + (pcm[i0 + 1] || 0) * f; }
  return out;
}
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12); };
function rmsNormalize(pcm, t = NORM_TARGET) { const r = rmsOf(pcm); if (r < 1e-6) return pcm; const g = t / r, o = new Float32Array(pcm.length); for (let i = 0; i < pcm.length; i++) o[i] = Math.max(-1, Math.min(1, pcm[i] * g)); return o; }
const loopTo = (pcm, sec) => { const need = SR * sec; if (pcm.length >= need) return pcm.subarray(0, need); const o = new Float32Array(need); for (let i = 0; i < need; i++) o[i] = pcm[i % pcm.length]; return o; };

function biquad(sig, b0, b1, b2, a1, a2) { const out = new Float32Array(sig.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < sig.length; i++) { const x0 = sig[i]; const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0; } return out; }
function bandpass(pcm, hpHz, lpHz) {
  const hw = 2 * Math.PI * hpHz / SR, ha = Math.sin(hw) / 1.4, hc = Math.cos(hw);
  let a0 = 1 + ha;
  let s = biquad(pcm, (1 + hc) / 2 / a0, -(1 + hc) / a0, (1 + hc) / 2 / a0, -2 * hc / a0, (1 - ha) / a0);
  const lw = 2 * Math.PI * lpHz / SR, la = Math.sin(lw) / 1.4, lc = Math.cos(lw);
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
const FAULTS = art.faults.map(f => ({ family: f.fault_type || f.label, emb: dq(f.q) }));
const ANCH = art.anchors.map(a => dq(a.q));

function gate(sc) {
  let t1 = 0, veh = 0, intf = 0;
  for (let i = 0; i < sc.length; i++) { if (sc[i] > sc[t1]) t1 = i; if (VEH.has(i) && sc[i] > veh) veh = sc[i]; if (INTF.has(i) && sc[i] > intf) intf = sc[i]; }
  return VEH.has(t1) || (!INTF.has(t1) && intf < 0.15) || (veh >= 0.03 && veh > intf);
}

// seeds vary the noise realisation — a robustness check, not one exact playback
const CASES = [
  ['RockerArmAndValve.wav', 2.0, 'rocker_valve'],
  ['Issue_with_Power_steering_or_low_oil_or_serpentine_belt_4.wav', 1.0, 'power_steering'],
  ['Issue_with_Power_steering_or_low_oil_or_serpentine_belt_4.wav', 2.0, 'power_steering'],
];
for (const [file, dist, expected] of CASES) {
  const buf = Buffer.from(await (await fetch(BUCKET + encodeURIComponent(file))).arrayBuffer());
  const d = decodeWav(buf);
  const p16 = resampleTo16k(d.pcm, d.rate);
  for (const seed of [7, 21, 63]) {
    const sess = loopTo(replayChannel(p16, dist, seed), SESSION_SEC);
    const fam = new Map();
    let accepted = 0;
    for (let off = 0; off + WIN <= sess.length; off += WIN) {
      const w = sess.subarray(off, off + WIN);
      if (rmsOf(w) < 0.005) continue;
      const { sc, emb } = tf.tidy(() => {
        const [scores, embeddings] = model.predict(tf.tensor1d(rmsNormalize(w)));
        return { sc: Array.from(tf.mean(scores, 0).dataSync()), emb: Array.from(tf.mean(embeddings, 0).dataSync()) };
      });
      if (!gate(sc)) continue;
      accepted++;
      let bf = -1, bfam = null;
      for (const f of FAULTS) { const c = cosine(emb, f.emb); if (c > bf) { bf = c; bfam = f.family; } }
      let ba = 0;
      for (const a of ANCH) { const c = cosine(emb, a); if (c > ba) ba = c; }
      const margin = bf - ba;
      if (bf >= TAU && margin >= MARGIN) {
        const v = fam.get(bfam) || { hits: 0, marginSum: 0, simSum: 0 };
        v.hits++; v.marginSum += margin; v.simSum += bf;
        fam.set(bfam, v);
      }
    }
    const rows = [...fam.entries()].map(([f, v]) => `${f}{h:${v.hits},mSum:${v.marginSum.toFixed(3)},sSum:${v.simSum.toFixed(3)}}`);
    // which family would each tie-break pick?
    const byMargin = [...fam.entries()].sort((a, b) => b[1].marginSum - a[1].marginSum)[0];
    const bySim = [...fam.entries()].sort((a, b) => b[1].simSum - a[1].simSum)[0];
    console.log(`${file}@${dist}m seed=${seed} acc=${accepted} | ${rows.join(' ')} | byMarginSum->${byMargin ? byMargin[0] : '-'} bySimSum->${bySim ? bySim[0] : '-'} expected=${expected}`);
  }
}
