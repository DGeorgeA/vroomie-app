/**
 * rca_gate_boundary.mjs — measure the (veh, intf) score plane on BOTH sides:
 *   POSITIVE side: windows of reference files that the interferer-top-1 veto
 *   currently kills (across digital / replay / phone-speaker channels)
 *   NEGATIVE side: windows of real speech recordings, synth music, and the
 *   speech-like negatives that the veto exists to reject
 * Goal: find whether a boundary exists that recovers the vetoed reference
 * windows without admitting any speech/music window. Measure only.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
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
  if (fmt.ch > 1) {
    m = new Float32Array(Math.floor(n / fmt.ch));
    for (let i = 0; i < m.length; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += x[i * fmt.ch + c]; m[i] = s / fmt.ch; }
  }
  return { pcm: m, rate: fmt.rate };
}
function rs(p, f) {
  if (f === SR) return p;
  const r = f / SR, o = new Float32Array(Math.floor(p.length / r));
  for (let i = 0; i < o.length; i++) { const s = i * r, i0 = Math.floor(s), fr = s - i0; o[i] = (p[i0] || 0) * (1 - fr) + (p[i0 + 1] || 0) * fr; }
  return o;
}
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
const norm = (p, t = 0.05) => { const r = rmsOf(p); if (r < 1e-6) return p; const g = t / r, o = new Float32Array(p.length); for (let i = 0; i < p.length; i++) o[i] = Math.max(-1, Math.min(1, p[i] * g)); return o; };
const loopTo = (p, sec) => { const need = SR * sec; if (p.length >= need) return p.subarray(0, need); const o = new Float32Array(need); for (let i = 0; i < need; i++) o[i] = p[i % p.length]; return o; };
function biquad(sig, b0, b1, b2, a1, a2) { const out = new Float32Array(sig.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < sig.length; i++) { const x0 = sig[i]; const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0; } return out; }
function bandpass(pcm, hpHz, lpHz, q = 1.4) {
  const hw = 2 * Math.PI * hpHz / SR, ha = Math.sin(hw) / q, hc = Math.cos(hw);
  let a0 = 1 + ha;
  let s = biquad(pcm, (1 + hc) / 2 / a0, -(1 + hc) / a0, (1 + hc) / 2 / a0, -2 * hc / a0, (1 - ha) / a0);
  const lw = 2 * Math.PI * lpHz / SR, la = Math.sin(lw) / q, lc = Math.cos(lw);
  a0 = 1 + la;
  return biquad(s, (1 - lc) / 2 / a0, (1 - lc) / a0, (1 - lc) / 2 / a0, -2 * lc / a0, (1 - la) / a0);
}
function mulberry32(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function replaySim(pcm, seed = 7) {
  const rnd = mulberry32(seed);
  let s = bandpass(pcm, 250, 7500);
  const out = new Float32Array(s.length);
  const d1 = Math.floor(SR * 0.013), d2 = Math.floor(SR * 0.027);
  for (let i = 0; i < s.length; i++) out[i] = s[i] + 0.30 * (i > d1 ? s[i - d1] : 0) + 0.165 * (i > d2 ? s[i - d2] : 0);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.53 + (rnd() * 2 - 1) * 0.0016;
  return out;
}
function phoneSpeakerSim(pcm, seed = 7) {
  const rnd = mulberry32(seed);
  let s = bandpass(pcm, 400, 4500, 0.9);
  const w = 2 * Math.PI * 1200 / SR, alpha = Math.sin(w) / (2 * 1.2), A = Math.pow(10, 6 / 40);
  const a0 = 1 + alpha / A;
  s = biquad(s, (1 + alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha / A) / a0);
  for (let i = 0; i < s.length; i++) s[i] = Math.tanh(s[i] * 3.0) / 3.0;
  const d1 = Math.floor(SR * 0.008);
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] + 0.35 * (i > d1 ? s[i - d1] : 0);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.6 + (rnd() * 2 - 1) * 0.002;
  return out;
}

const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });

function windowScores(sessPcm) {
  const out = [];
  for (let off = 0; off + WIN <= sessPcm.length; off += WIN) {
    const w = sessPcm.subarray(off, off + WIN);
    if (rmsOf(w) < 0.005) continue;
    const sc = tf.tidy(() => {
      const [scores] = model.predict(tf.tensor1d(norm(w)));
      return Array.from(tf.mean(scores, 0).dataSync());
    });
    let t1 = 0, veh = 0, intf = 0;
    for (let i = 0; i < sc.length; i++) {
      if (sc[i] > sc[t1]) t1 = i;
      if (VEH.has(i) && sc[i] > veh) veh = sc[i];
      if (INTF.has(i) && sc[i] > intf) intf = sc[i];
    }
    out.push({ top1: CLASSES[t1], top1Score: +sc[t1].toFixed(3), intfTop1: INTF.has(t1), veh: +veh.toFixed(3), intf: +intf.toFixed(3) });
  }
  return out;
}

// POSITIVE SIDE: currently-vetoed windows of the failing reference files
const POS_FILES = ['alternator_bearing_fault_critical.wav', 'MotorStarter.wav', 'misfire_detected_medium.wav',
                   'Issue_with_Power_steering_or_low_oil_or_serpentine_belt_70.wav'];
console.log('=== POSITIVE side (reference windows killed by the interferer-top-1 veto) ===');
const posVetoed = [];
for (const name of POS_FILES) {
  const raw = decodeWav(Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer()));
  const p16 = rs(raw.pcm, raw.rate);
  for (const [cond, pcm] of [['dig', loopTo(p16, 12)], ['replay', loopTo(replaySim(p16), 12)], ['spk', loopTo(phoneSpeakerSim(p16), 12)]]) {
    for (const w of windowScores(pcm)) {
      if (w.intfTop1 && !(w.veh >= 0.03 && w.veh > w.intf)) {   // currently rejected
        posVetoed.push({ ...w, file: name, cond });
      }
    }
  }
}
for (const w of posVetoed) console.log(`  ${w.file.slice(0, 28).padEnd(29)} ${w.cond.padEnd(6)} top1=${w.top1}(${w.top1Score}) veh=${w.veh} intf=${w.intf} ratio=${(w.veh / Math.max(w.intf, 1e-6)).toFixed(2)}`);

// NEGATIVE SIDE: real speech, synth music — every window, with its gate fate
console.log('\n=== NEGATIVE side (speech/music windows — NONE may cross the boundary) ===');
const negWindows = [];
const TESTAUDIO = path.join(ROOT, 'scratch', 'testaudio');
for (const f of fs.readdirSync(TESTAUDIO).filter(f => /\.wav$/i.test(f))) {
  const d = decodeWav(fs.readFileSync(path.join(TESTAUDIO, f)));
  const p16 = rs(d.pcm, d.rate);
  // both direct AND through the phone-speaker channel (user may have TV near a speaker etc.)
  for (const [cond, pcm] of [['dig', loopTo(p16, 12)], ['spk', loopTo(phoneSpeakerSim(p16), 12)]]) {
    for (const w of windowScores(pcm)) negWindows.push({ ...w, file: f, cond });
  }
}
// synth music
{
  const n = SR * 12, out = new Float32Array(n);
  const notes = [261.6, 329.6, 392.0, 523.3];
  for (let i = 0; i < n; i++) {
    const t = i / SR, seg = Math.floor(t * 2) % notes.length, fq = notes[seg];
    out[i] = 0.16 * (Math.sin(2 * Math.PI * fq * t) + 0.5 * Math.sin(4 * Math.PI * fq * t) + 0.25 * Math.sin(6 * Math.PI * fq * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t));
  }
  for (const w of windowScores(out)) negWindows.push({ ...w, file: 'music_synth', cond: 'dig' });
}
const negIntfTop1 = negWindows.filter(w => w.intfTop1);
for (const w of negIntfTop1) console.log(`  ${w.file.slice(0, 28).padEnd(29)} ${w.cond.padEnd(6)} top1=${w.top1}(${w.top1Score}) veh=${w.veh} intf=${w.intf} ratio=${(w.veh / Math.max(w.intf, 1e-6)).toFixed(2)}`);

// BOUNDARY SEARCH: accept-if (intfTop1 && veh >= F && intf <= C && veh >= K*intf)
console.log('\n=== BOUNDARY GRID: recovered-positives vs admitted-negatives ===');
console.log('floor  ceil   k    | posRecovered/'+posVetoed.length+' negAdmitted/'+negIntfTop1.length);
for (const F of [0.02, 0.03, 0.05]) {
  for (const C of [0.15, 0.2, 0.3, 0.5]) {
    for (const K of [0, 0.25, 0.5, 0.75]) {
      const pos = posVetoed.filter(w => w.veh >= F && w.intf <= C && w.veh >= K * w.intf).length;
      const neg = negIntfTop1.filter(w => w.veh >= F && w.intf <= C && w.veh >= K * w.intf).length;
      if (pos > 0) console.log(`${F.toFixed(2)}   ${C.toFixed(2)}  ${K.toFixed(2)} | ${String(pos).padStart(3)}            ${neg}`);
    }
  }
}
fs.writeFileSync(path.join(ROOT, 'scratch', 'rca_gate_boundary.json'), JSON.stringify({ posVetoed, negIntfTop1 }, null, 1));
