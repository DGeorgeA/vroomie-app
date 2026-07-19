/**
 * validate_youtube_sample.mjs — verifies the real-world alternator bearing
 * recording (reference_audio/alternator_bearing_noise_2.wav, sourced from the
 * user's failing field test) is detected by the EXACT v9.3 live pipeline
 * against the current artifact — raw, through the speaker→room→mic channel,
 * and at quiet capture level.
 *
 * Usage: node scripts/validate_youtube_sample.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const TAU = 0.60, MARGIN = 0.05;

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

function decodeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') fmt = { channels: dv.getUint16(pos + 10, true), sampleRate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
    else if (id === 'data') { dataOff = pos + 8; dataLen = size; }
    pos += 8 + size + (size % 2);
  }
  const frames = Math.floor(Math.min(dataLen, dv.byteLength - dataOff) / 2);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = dv.getInt16(dataOff + i * 2, true) / 32768;
  return out; // already 16k mono by construction
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
const scaleTo = (pcm, t) => {
  const g = t / Math.max(1e-6, rmsOf(pcm));
  const o = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) o[i] = pcm[i] * g;
  return o;
};
const loopTo = (pcm, sec) => {
  const out = new Float32Array(SR * sec);
  for (let i = 0; i < out.length; i++) out[i] = pcm[i % pcm.length];
  return out;
};

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
console.log(`[YT-Validate] artifact: ${FAULTS.length} fault embeddings (labels incl: ${[...new Set(FAULTS.map(f => f.label))].filter(l => l.includes('bearing') || l.includes('Bearing')).join(' | ')})`);

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
function session(name, pcm) {
  const per = new Map();
  let accepted = 0, rejected = 0;
  for (let s = 0; s + WIN <= pcm.length; s += WIN) {
    const w = pcm.slice(s, s + WIN);
    if (rmsOf(w) < 0.005) { rejected++; continue; }
    const { emb, sc } = analyze(rmsNormalize(w));
    if (!gate(sc)) { rejected++; continue; }
    accepted++;
    let bf = -1, bl = null;
    for (const f of FAULTS) { const c = cosine(emb, f.emb); if (c > bf) { bf = c; bl = f.label; } }
    let ba = 0;
    for (const a of ANCH) { const c = cosine(emb, a); if (c > ba) ba = c; }
    if (bf >= TAU && bf - ba >= MARGIN) per.set(bl, (per.get(bl) || 0) + 1);
  }
  const confirmed = [];
  for (const [l, c] of per) if (accepted >= 4 && c / accepted >= 0.5) confirmed.push(`${l} (${c}/${accepted})`);
  const best = [...per.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(`  ${name.padEnd(34)} ${confirmed.length ? 'DETECT: ' + confirmed.join('; ') : `MISS (best ${best ? best[0] + ' ' + best[1] + '/' + accepted : '0 candidates/' + accepted})`}`);
  return confirmed.length > 0;
}

const clip = decodeWav(fs.readFileSync(path.join(ROOT, 'reference_audio', 'alternator_bearing_noise_2.wav')));
console.log(`[YT-Validate] clip: ${(clip.length / SR).toFixed(1)}s rms=${rmsOf(clip).toFixed(4)}`);
console.log('\n■ YouTube alternator bearing sample vs current artifact:');
let ok = 0;
ok += session('raw (direct)', loopTo(clip, 20));
ok += session('speaker→room→mic channel', replayChannel(loopTo(clip, 20)));
ok += session('quiet capture (rms 0.008)', scaleTo(replayChannel(loopTo(clip, 20)), 0.008));
console.log(`\nRESULT: ${ok}/3 variants detected`);
process.exit(ok === 3 ? 0 : 1);
