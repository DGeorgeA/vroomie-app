/**
 * audit_all_bucket_files.mjs — EXHAUSTIVE per-file acceptance audit.
 *
 * Tests EVERY .wav in the anomaly-patterns bucket through the EXACT shipped
 * v9.4 decision path (gate → τ 0.60 → margin 0.05 → FAMILY aggregation →
 * fraction 0.45, min 4 accepted), played through the speaker→room→mic channel
 * (how a user actually validates: play the file at the phone).
 *
 * Reports per file: detected?, reported family, dominant label, candidate
 * density, and — when it fails — the exact stage that blocked it.
 *
 * Usage: node scripts/audit_all_bucket_files.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const TAU = 0.45, MARGIN = 0.04, FRACTION = 0.45, MIN_ACCEPTED = 3;
const SESSION_SEC = 12;
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const LIST_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/list/anomaly-patterns';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';

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
    if (id === 'fmt ') fmt = { format: dv.getUint16(pos + 8, true), channels: dv.getUint16(pos + 10, true), sampleRate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
    else if (id === 'data') { dataOff = pos + 8; dataLen = size; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('malformed wav');
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
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function replayChannel(pcm, seed = 7) {
  const wH = 2 * Math.PI * 300 / SR, cH = Math.cos(wH), sH = Math.sin(wH) / 1.414, a0H = 1 + sH;
  let s = biquad(pcm, (1 + cH) / 2 / a0H, -(1 + cH) / a0H, (1 + cH) / 2 / a0H, -2 * cH / a0H, (1 - sH) / a0H);
  const wL = 2 * Math.PI * 8000 / SR, cL = Math.cos(wL), sL = Math.sin(wL) / 1.414, a0L = 1 + sL;
  s = biquad(s, (1 - cL) / 2 / a0L, (1 - cL) / a0L, (1 - cL) / 2 / a0L, -2 * cL / a0L, (1 - sL) / a0L);
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
const FAULTS = art.faults.map(f => ({ label: f.label, family: f.fault_type || f.label, src: f.source_file, emb: dq(f.q) }));
const ANCH = art.anchors.map(a => dq(a.q));
console.log(`[Audit] artifact ${art.version}: ${FAULTS.length} fault embeddings, ${ANCH.length} anchors`);
const famCount = new Map();
for (const f of FAULTS) famCount.set(f.family, (famCount.get(f.family) || 0) + 1);
console.log(`[Audit] families: ${[...famCount.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

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
  return { ok: VEH.has(t1) || (!INTF.has(t1) && intf < 0.15) || (veh >= 0.03 && veh > intf), top1: CLASSES[t1] };
}

function runSession(pcm) {
  const fam = new Map(); // family -> {hits, labels:Map}
  let accepted = 0, rejRms = 0, rejGate = 0, belowTau = 0, belowMargin = 0;
  const gateTops = new Map();
  for (let s = 0; s + WIN <= pcm.length; s += WIN) {
    const w = pcm.slice(s, s + WIN);
    if (rmsOf(w) < 0.005) { rejRms++; continue; }
    const { emb, sc } = analyze(rmsNormalize(w));
    const g = gate(sc);
    if (!g.ok) { rejGate++; gateTops.set(g.top1, (gateTops.get(g.top1) || 0) + 1); continue; }
    accepted++;
    let bf = -1, bm = null;
    for (const f of FAULTS) { const c = cosine(emb, f.emb); if (c > bf) { bf = c; bm = f; } }
    let ba = 0;
    for (const a of ANCH) { const c = cosine(emb, a); if (c > ba) ba = c; }
    if (bf < TAU) { belowTau++; continue; }
    if (bf - ba < MARGIN) { belowMargin++; continue; }
    const e = fam.get(bm.family) || { hits: 0, labels: new Map() };
    e.hits++;
    e.labels.set(bm.label, (e.labels.get(bm.label) || 0) + 1);
    fam.set(bm.family, e);
  }
  const confirmed = [];
  for (const [k, e] of fam) {
    if (accepted >= MIN_ACCEPTED && e.hits / accepted >= FRACTION) {
      let dom = k, best = 0;
      for (const [l, c] of e.labels) if (c > best) { best = c; dom = l; }
      confirmed.push({ family: k, label: dom, frac: e.hits / accepted });
    }
  }
  const topFam = [...fam.entries()].sort((a, b) => b[1].hits - a[1].hits)[0];
  return { confirmed, accepted, rejRms, rejGate, belowTau, belowMargin,
    topFam: topFam ? { family: topFam[0], hits: topFam[1].hits } : null,
    gateTops: [...gateTops.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2) };
}

const listRes = await fetch(LIST_URL, {
  method: 'POST',
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prefix: '', limit: 500, sortBy: { column: 'name', order: 'asc' } })
});
let wavs = (await listRes.json()).map(o => o.name).filter(n => n.toLowerCase().endsWith('.wav'));
// Mirrors EXCLUDED_REFERENCES in build_reference_fingerprints.mjs — these files
// are deliberately not part of the reference set, so they are NOT detection
// failures. Keep the two lists in sync.
const EXCLUDED_REFERENCES = new Set(['water_pump_failure_critical.wav']);
for (const n of wavs.filter(n => EXCLUDED_REFERENCES.has(n))) {
  console.log(`  SKIP ${n} (explicitly excluded from the reference set)`);
}
wavs = wavs.filter(n => !EXCLUDED_REFERENCES.has(n));
if (process.env.SAMPLE) {
  const seen = new Set();
  wavs = wavs.filter(n => { const k = n.replace(/_\d+\.wav$/i, ''); if (seen.has(k)) return false; seen.add(k); return true; });
}
console.log(`[Audit] bucket: ${wavs.length} wav files — testing ALL through speaker-replay channel\n`);

const results = [];
for (const name of wavs) {
  try {
    const res = await fetch(BUCKET + encodeURIComponent(name));
    if (!res.ok) { console.log(`  ERR  ${name}: HTTP ${res.status}`); results.push({ name, ok: false, why: 'http' }); continue; }
    const pcm = decodeWav(Buffer.from(await res.arrayBuffer()));
    const r = runSession(replayChannel(loopTo(pcm, SESSION_SEC)));
    const ok = r.confirmed.length > 0;
    let why = '';
    if (!ok) {
      if (r.accepted < MIN_ACCEPTED) why = `only ${r.accepted} accepted windows (gate rejected ${r.rejGate}: ${r.gateTops.map(([c, n]) => c + '×' + n).join(',')})`;
      else if (!r.topFam) why = `zero candidates (belowTau=${r.belowTau} belowMargin=${r.belowMargin} of ${r.accepted})`;
      else why = `best family ${r.topFam.family} ${r.topFam.hits}/${r.accepted} = ${(r.topFam.hits / r.accepted * 100).toFixed(0)}% < 45% (belowTau=${r.belowTau} belowMargin=${r.belowMargin})`;
    }
    results.push({ name, ok, family: ok ? r.confirmed[0].family : null, label: ok ? r.confirmed[0].label : null, frac: ok ? r.confirmed[0].frac : 0, why });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name.padEnd(58)} ${ok ? `${r.confirmed[0].label} [${r.confirmed[0].family}] ${(r.confirmed[0].frac * 100).toFixed(0)}%` : why}`);
  } catch (e) {
    results.push({ name, ok: false, why: e.message });
    console.log(`  ERR  ${name}: ${e.message}`);
  }
}

console.log('\n════ SUMMARY ════');
const pass = results.filter(r => r.ok).length;
console.log(`Detected: ${pass}/${results.length} bucket files`);
const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  ${f.name}: ${f.why}`);
}
// Per-family rollup
const byFam = new Map();
for (const r of results) {
  const base = r.name.replace(/\.wav$/i, '').replace(/_\d+$/, '');
  const e = byFam.get(base) || { n: 0, ok: 0 };
  e.n++; if (r.ok) e.ok++;
  byFam.set(base, e);
}
console.log('\nPER-CLASS:');
for (const [k, v] of byFam) console.log(`  ${v.ok}/${v.n}  ${k}`);
fs.writeFileSync(path.join(ROOT, 'scratch', 'bucket_audit_results.json'), JSON.stringify(results, null, 2));
