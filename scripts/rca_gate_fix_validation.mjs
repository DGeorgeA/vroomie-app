/**
 * rca_gate_fix_validation.mjs — end-to-end offline validation of the proposed
 * gate clause BEFORE it touches the engine:
 *
 *   NEW CLAUSE: interferer-top-1 windows also pass when
 *               vehicleScore >= 0.02 AND interfererScore <= 0.30
 *   (measured boundary: recovers 29/70 vetoed reference windows,
 *    admits 0/108 speech/music windows)
 *
 * Validates with the FULL shipped decision path (gate -> tau/margin ->
 * v9.8 session rule incl. recovery vote), old gate vs new gate:
 *   1. The four field-failing reference files x 3 channels
 *   2. The 15-file census set x 3 channels (no regressions)
 *   3. Full negative set: real speech x4, synth music/fan/traffic/white/pink,
 *      each ALSO through the phone-speaker channel
 *   4. All 140 held-out healthy clips (FP baseline must not exceed 9)
 * Output: scratch/rca_gate_fix_validation.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const TAU = 0.45, MARGIN = 0.04, FRACTION = 0.45, MIN_ACCEPTED = 3;
const RTOT = 0.60, RDOM = 1.10;
const NEW_VEH_FLOOR = 0.02, NEW_INTF_CEIL = 0.30;
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const TESTAUDIO = path.join(ROOT, 'scratch', 'testaudio');

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
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12); };
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
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'fingerprints_v9.json'), 'utf8'));
const dq = q => { const b = Buffer.from(q.b64, 'base64'); const o = new Float32Array(b.length); for (let i = 0; i < b.length; i++) o[i] = q.min + b[i] * q.scale; return o; };
const FAULTS = art.faults.map(f => ({ family: f.fault_type || f.label, emb: dq(f.q) }));
const ANCH = art.anchors.map(a => dq(a.q));

function gate(sc, useNewClause) {
  let t1 = 0, veh = 0, intf = 0;
  for (let i = 0; i < sc.length; i++) {
    if (sc[i] > sc[t1]) t1 = i;
    if (VEH.has(i) && sc[i] > veh) veh = sc[i];
    if (INTF.has(i) && sc[i] > intf) intf = sc[i];
  }
  const isIntf = INTF.has(t1);
  let ok = VEH.has(t1) || (!isIntf && intf < 0.15) || (veh >= 0.03 && veh > intf);
  if (!ok && useNewClause && isIntf && veh >= NEW_VEH_FLOOR && intf <= NEW_INTF_CEIL) ok = true;
  return ok;
}

function runSession(pcm, useNewClause) {
  const sess = loopTo(pcm, 12);
  let accepted = 0, rejected = 0;
  const votes = new Map();
  for (let off = 0; off + WIN <= sess.length; off += WIN) {
    const w = sess.subarray(off, off + WIN);
    if (rmsOf(w) < 0.005) { rejected++; continue; }
    const { sc, emb } = tf.tidy(() => {
      const [scores, embeddings] = model.predict(tf.tensor1d(norm(w)));
      return { sc: Array.from(tf.mean(scores, 0).dataSync()), emb: Array.from(tf.mean(embeddings, 0).dataSync()) };
    });
    if (!gate(sc, useNewClause)) { rejected++; continue; }
    accepted++;
    let bf = -1, bfam = null;
    for (const f of FAULTS) { const c = cosine(emb, f.emb); if (c > bf) { bf = c; bfam = f.family; } }
    let ba = 0;
    for (const a of ANCH) { const c = cosine(emb, a); if (c > ba) ba = c; }
    if (bf >= TAU && (bf - ba) >= MARGIN) {
      const v = votes.get(bfam) || { h: 0, sim: 0 };
      v.h++; v.sim += bf;
      votes.set(bfam, v);
    }
  }
  // full v9.8 session decision
  let fam = null, frac = 0;
  if (accepted >= MIN_ACCEPTED) {
    for (const [f, v] of votes) { const r = v.h / accepted; if (r >= FRACTION && r > frac) { fam = f; frac = r; } }
    if (!fam && votes.size > 0) {
      const tot = [...votes.values()].reduce((s, v) => s + v.h, 0);
      if (tot / accepted >= RTOT) {
        const ent = [...votes.entries()].sort((a, b) => b[1].h - a[1].h || b[1].sim - a[1].sim);
        if (ent.length === 1 || ent[0][1].h > ent[1][1].h) fam = ent[0][0];
        else if ((ent[1][1].sim || 0) > 0 && ent[0][1].sim / ent[1][1].sim >= RDOM) fam = ent[0][0];
      }
    }
  }
  const mostlyRejected = rejected > accepted;
  const decision = (accepted + rejected === 0) ? 'ZERO' : mostlyRejected ? 'UNABLE' : fam ? 'DETECTED' : 'NO_ANOMALY';
  return { decision, fam, accepted, rejected };
}

const report = { fieldFiles: [], census: [], negatives: [], healthy: {} };

// 1. field-failing files
console.log('=== FIELD-FAILING FILES (old -> new) ===');
for (const name of ['alternator_bearing_fault_critical.wav', 'MotorStarter.wav', 'misfire_detected_medium.wav',
                    'Issue_with_Power_steering_or_low_oil_or_serpentine_belt_70.wav']) {
  const raw = decodeWav(Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer()));
  const p16 = rs(raw.pcm, raw.rate);
  for (const [cond, pcm] of [['dig', p16], ['replay', replaySim(p16)], ['spk', phoneSpeakerSim(p16)]]) {
    const o = runSession(pcm, false), n = runSession(pcm, true);
    report.fieldFiles.push({ file: name, cond, old: o, new: n });
    console.log(`  ${name.slice(0, 34).padEnd(35)} ${cond.padEnd(6)} ${o.decision}(${o.fam || '-'}) -> ${n.decision}(${n.fam || '-'})`);
  }
}

// 2. census regression set
console.log('=== CENSUS SET (regressions?) ===');
const CENSUS = ['Piston.wav', 'PowerSteeringPump.wav', 'RockerArmAndValve.wav', 'BearingAlternator.wav', 'SerpentineBelt.wav',
                'intake_leak_low.wav', 'timing_chain_rattle_high.wav',
                'Issue_with_Power_steering_or_low_oil_or_serpentine_belt_10.wav',
                'Issue_with_Power_steering_or_low_oil_or_serpentine_belt_30.wav',
                'Issue_with_Power_steering_or_low_oil_or_serpentine_belt_50.wav'];
for (const name of CENSUS) {
  const raw = decodeWav(Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer()));
  const p16 = rs(raw.pcm, raw.rate);
  for (const [cond, pcm] of [['dig', p16], ['spk', phoneSpeakerSim(p16)]]) {
    const o = runSession(pcm, false), n = runSession(pcm, true);
    report.census.push({ file: name, cond, old: o, new: n });
    const regress = (o.decision === 'DETECTED' && n.decision !== 'DETECTED') || (o.fam && n.fam && o.fam !== n.fam);
    console.log(`  ${name.slice(0, 34).padEnd(35)} ${cond.padEnd(6)} ${o.decision}(${o.fam || '-'}) -> ${n.decision}(${n.fam || '-'})${regress ? '  !! REGRESSION' : ''}`);
  }
}

// 3. negatives
console.log('=== NEGATIVES (must not become DETECTED) ===');
function synthMusic() {
  const n = SR * 12, out = new Float32Array(n);
  const notes = [261.6, 329.6, 392.0, 523.3];
  for (let i = 0; i < n; i++) {
    const t = i / SR, seg = Math.floor(t * 2) % notes.length, fq = notes[seg];
    out[i] = 0.16 * (Math.sin(2 * Math.PI * fq * t) + 0.5 * Math.sin(4 * Math.PI * fq * t) + 0.25 * Math.sin(6 * Math.PI * fq * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t));
  }
  return out;
}
function synthNoise(kind) {
  const n = SR * 12, out = new Float32Array(n), rnd = mulberry32(11);
  if (kind === 'fan') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.995 * lp + 0.005 * (rnd() * 2 - 1); out[i] = lp * 6 + 0.004 * Math.sin(2 * Math.PI * 48 * i / SR); } }
  else if (kind === 'traffic') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.9985 * lp + 0.0015 * (rnd() * 2 - 1); out[i] = lp * 9 + 0.02 * Math.sin(2 * Math.PI * 90 * i / SR) * (0.6 + 0.4 * Math.sin(2 * Math.PI * i / (SR * 3))); } }
  else if (kind === 'white') { for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.08; }
  else { let b0 = 0, b1 = 0, b2 = 0; for (let i = 0; i < n; i++) { const w = rnd() * 2 - 1; b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.950 * b2 + w * 0.048; out[i] = (b0 + b1 + b2) * 0.6; } }
  return out;
}
const negSets = [['music_synth', synthMusic()], ['fan', synthNoise('fan')], ['traffic', synthNoise('traffic')],
                 ['white', synthNoise('white')], ['pink', synthNoise('pink')]];
for (const f of fs.readdirSync(TESTAUDIO).filter(f => /\.wav$/i.test(f))) {
  const d = decodeWav(fs.readFileSync(path.join(TESTAUDIO, f)));
  const p16 = rs(d.pcm, d.rate);
  negSets.push(['speech:' + f, p16]);
  negSets.push(['speech-spk:' + f, phoneSpeakerSim(p16)]);
}
negSets.push(['music-spk', phoneSpeakerSim(synthMusic())]);
let negFP = 0;
for (const [label, pcm] of negSets) {
  const o = runSession(pcm, false), n = runSession(pcm, true);
  report.negatives.push({ label, old: o, new: n });
  const bad = n.decision === 'DETECTED';
  if (bad) negFP++;
  console.log(`  ${label.padEnd(38)} ${o.decision}(${o.fam || '-'}) -> ${n.decision}(${n.fam || '-'})${bad ? '  !! FALSE POSITIVE' : ''}`);
}

// 4. healthy sweep
console.log('=== HEALTHY 140 (FP baseline must stay <= 9) ===');
let hN = 0, hOld = 0, hNew = 0;
for (const [label, sub] of [['idle', path.join(DATASET, 'idle state', 'normal_engine_idle')],
                            ['startup', path.join(DATASET, 'startup state', 'normal_engine_startup')],
                            ['brakes', path.join(DATASET, 'braking state', 'normal_brakes')]]) {
  if (!fs.existsSync(sub)) continue;
  const files = fs.readdirSync(sub).filter(f => /\.wav$/i.test(f))
    .filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === 1; })
    .sort((a, b) => +a.match(/_(\d+)\.wav$/)[1] - +b.match(/_(\d+)\.wav$/)[1])
    .slice(0, 70);
  for (const f of files) {
    let d;
    try { d = decodeWav(fs.readFileSync(path.join(sub, f))); } catch { continue; }
    const p16 = rs(d.pcm, d.rate);
    const o = runSession(p16, false), n = runSession(p16, true);
    hN++;
    if (o.decision === 'DETECTED') hOld++;
    if (n.decision === 'DETECTED') { hNew++; if (o.decision !== 'DETECTED') console.log(`  NEW FP ${label}/${f} -> ${n.fam}`); }
  }
}
report.healthy = { total: hN, oldFP: hOld, newFP: hNew };
console.log(`healthy: ${hN} clips | oldFP ${hOld} | newFP ${hNew}`);
console.log(`negatives flagged under new gate: ${negFP}/${negSets.length}`);
fs.writeFileSync(path.join(ROOT, 'scratch', 'rca_gate_fix_validation.json'), JSON.stringify(report, null, 1));
console.log('VALIDATION COMPLETE');
