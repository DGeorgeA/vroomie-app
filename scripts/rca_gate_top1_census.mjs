/**
 * rca_gate_top1_census.mjs — P0 field-failure diagnosis.
 *
 * User report: EVERY reference sample played at a real device mic returns
 * "Unable to detect vehicle audio" (= isMostlyRejected: >50% of windows
 * rejected by silence gate or domain gate).
 *
 * Hypothesis under test: real speaker playback colors the audio so YAMNet's
 * top-1 becomes an INTERFERER class (Radio / Television / Speech / Music),
 * which hard-vetoes the window at the domain gate regardless of vehicle
 * evidence. The bandpass+echo sim never modeled speaker coloration harshly
 * enough to trigger it.
 *
 * Measures, per bucket file, per channel condition:
 *   - top-1 class distribution across windows
 *   - gate verdict breakdown (which clause passed / which rejection)
 *   - how often an interferer-top-1 veto killed a window that HAD vehicle
 *     evidence (veh >= floor) — the recoverable population
 * Conditions: digital | replay sim | HARSH phone-speaker sim (strong band
 * limit 400-4500 Hz + resonance + compression) — approximating a small
 * phone/laptop speaker.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const VEHICLE_FLOOR = 0.03, INTERFERER_CEIL = 0.15;
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const LIST_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/list/anomaly-patterns';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';

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
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22), format: buf.readUInt16LE(pos + 8) };
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
function replaySim(pcm, seed = 7) {   // the original (gentle) channel
  const rnd = mulberry32(seed);
  let s = bandpass(pcm, 250, 7500);
  const out = new Float32Array(s.length);
  const d1 = Math.floor(SR * 0.013), d2 = Math.floor(SR * 0.027);
  for (let i = 0; i < s.length; i++) out[i] = s[i] + 0.30 * (i > d1 ? s[i - d1] : 0) + 0.165 * (i > d2 ? s[i - d2] : 0);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.53 + (rnd() * 2 - 1) * 0.0016;
  return out;
}
/** HARSH phone-speaker sim: narrow band, mid resonance, soft-knee compression, tinny echo. */
function phoneSpeakerSim(pcm, seed = 7) {
  const rnd = mulberry32(seed);
  let s = bandpass(pcm, 400, 4500, 0.9);           // small-driver band limit
  // 1.2 kHz resonance bump (typical tiny speaker)
  const w = 2 * Math.PI * 1200 / SR, alpha = Math.sin(w) / (2 * 1.2), A = Math.pow(10, 6 / 40);
  const a0 = 1 + alpha / A;
  s = biquad(s, (1 + alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha / A) / a0);
  // soft-knee compression (speaker driver limiting)
  for (let i = 0; i < s.length; i++) s[i] = Math.tanh(s[i] * 3.0) / 3.0;
  // close reflection (desk) + noise
  const d1 = Math.floor(SR * 0.008);
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] + 0.35 * (i > d1 ? s[i - d1] : 0);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.6 + (rnd() * 2 - 1) * 0.002;
  return out;
}

const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });

function analyzeGate(sessPcm) {
  const counts = { veh_top1: 0, generic_ok: 0, veh_evidence: 0, rej_intf_top1: 0, rej_no_veh: 0, rej_silence: 0 };
  const top1 = new Map();
  let vetoedWithVehicleEvidence = 0;
  for (let off = 0; off + WIN <= sessPcm.length; off += WIN) {
    const w = sessPcm.subarray(off, off + WIN);
    if (rmsOf(w) < 0.005) { counts.rej_silence++; continue; }
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
    top1.set(CLASSES[t1], (top1.get(CLASSES[t1]) || 0) + 1);
    if (VEH.has(t1)) counts.veh_top1++;
    else if (!INTF.has(t1) && intf < INTERFERER_CEIL) counts.generic_ok++;
    else if (veh >= VEHICLE_FLOOR && veh > intf) counts.veh_evidence++;
    else if (INTF.has(t1)) { counts.rej_intf_top1++; if (veh >= VEHICLE_FLOOR) vetoedWithVehicleEvidence++; }
    else counts.rej_no_veh++;
  }
  const accepted = counts.veh_top1 + counts.generic_ok + counts.veh_evidence;
  const rejected = counts.rej_intf_top1 + counts.rej_no_veh + counts.rej_silence;
  return { counts, accepted, rejected, mostlyRejected: rejected > accepted,
           vetoedWithVehicleEvidence,
           top1: [...top1.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) };
}

const listRes = await fetch(LIST_URL, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 200, sortBy: { column: 'name', order: 'asc' } }) });
const wavs = (await listRes.json()).filter(o => /\.wav$/i.test(o.name)).map(o => o.name);
// census over a representative subset: all distinct classes + a sample of the big PS family
const distinct = wavs.filter(n => !/^Issue_with_Power/.test(n));
const psSample = wavs.filter(n => /^Issue_with_Power/.test(n)).filter((_, i) => i % 11 === 0);
const files = [...distinct, ...psSample];

const summary = { digital: { mostlyRejected: 0, total: 0 }, replay: { mostlyRejected: 0, total: 0 }, phoneSpk: { mostlyRejected: 0, total: 0 } };
const rows = [];
for (const name of files) {
  let raw;
  try { raw = decodeWav(Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer())); }
  catch (e) { continue; }
  const p16 = rs(raw.pcm, raw.rate);
  const conditions = { digital: loopTo(p16, 12), replay: loopTo(replaySim(p16), 12), phoneSpk: loopTo(phoneSpeakerSim(p16), 12) };
  const row = { file: name };
  for (const [cond, pcm] of Object.entries(conditions)) {
    const g = analyzeGate(pcm);
    row[cond] = g;
    summary[cond].total++;
    if (g.mostlyRejected) summary[cond].mostlyRejected++;
  }
  rows.push(row);
  const fmt = c => `${row[c].accepted}a/${row[c].rejected}r${row[c].mostlyRejected ? ' UNABLE' : ''}${row[c].vetoedWithVehicleEvidence ? ` veto+veh=${row[c].vetoedWithVehicleEvidence}` : ''}`;
  console.log(`${name.padEnd(46)} dig[${fmt('digital')}] replay[${fmt('replay')}] phoneSpk[${fmt('phoneSpk')}] top1=${row.phoneSpk.top1.map(t => t[0] + ':' + t[1]).join(',')}`);
}
console.log('\n=== SUMMARY: files that would show "Unable to detect" ===');
for (const [cond, s] of Object.entries(summary)) console.log(`  ${cond.padEnd(9)} ${s.mostlyRejected}/${s.total}`);
const vetoTotal = rows.reduce((s, r) => s + r.phoneSpk.vetoedWithVehicleEvidence, 0);
const intfTop1 = new Map();
for (const r of rows) for (const [c, n] of r.phoneSpk.top1) if (!VEH.has(CLASSES.indexOf(c))) intfTop1.set(c, (intfTop1.get(c) || 0) + n);
console.log('phoneSpk windows vetoed as interferer-top-1 DESPITE vehicle evidence:', vetoTotal);
console.log('phoneSpk most common non-vehicle top-1 classes:', [...intfTop1.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6));
fs.writeFileSync(path.join(ROOT, 'scratch', 'rca_gate_census.json'), JSON.stringify(rows, null, 1));
