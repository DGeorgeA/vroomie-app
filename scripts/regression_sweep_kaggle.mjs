/**
 * regression_sweep_kaggle.mjs — Phase-5 style regression sweep over real vehicle
 * audio (Kaggle car-diagnostics dataset) using the GATED pipeline exactly as
 * shipped in src/lib/mlEmbeddingEngine.js.
 *
 * Pass/fail cases:
 *   normal_engine_idle / normal_engine_startup / normal_brakes  -> must NOT flag an anomaly
 * Informational (unseen fault classes, no reference fingerprints exist for them —
 * any outcome except a crash is acceptable; reported for visibility):
 *   low_oil, serpentine_belt, power_steering, worn_out_brakes, bad_ignition, dead_battery
 *
 * Usage: node scripts/regression_sweep_kaggle.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const FP_CACHE = path.join(ROOT, 'scratch', 'validation_fingerprints_cache_v2.json');
const YAMNET_MODEL_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';
const SR = 16000, WIN = SR;
const ANOMALY_THRESHOLD = 0.60;
const VEHICLE_SCORE_FLOOR = 0.03;
const PERSISTENCE_HITS = 2;
const SINGLE_HIT_BYPASS_SCORE = 0.95;

// ─── class map + domain sets (identical to src/lib/mlEmbeddingEngine.js) ────
const csv = fs.readFileSync(path.join(__dirname, 'yamnet_class_map.csv'), 'utf8');
const CLASSES = csv.trim().split('\n').slice(1).map(raw => {
  const l = raw.replace(/\r$/, '');
  const m = l.match(/^\d+,[^,]+,(.*)$/);
  if (!m) throw new Error(`bad line ${l}`);
  let name = m[1].trim();
  if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  return name;
});
const VEHICLE_MECH_NAMES = [
  'Vehicle', 'Motor vehicle (road)', 'Car', 'Vehicle horn, car horn, honking', 'Car alarm',
  'Power windows, electric windows', 'Skidding', 'Tire squeal', 'Car passing by',
  'Race car, auto racing', 'Truck', 'Air brake', 'Air horn, truck horn', 'Reversing beeps',
  'Bus', 'Motorcycle', 'Traffic noise, roadway noise',
  'Engine', 'Light engine (high frequency)', 'Medium engine (mid frequency)',
  'Heavy engine (low frequency)', 'Engine knocking', 'Engine starting', 'Idling',
  'Accelerating, revving, vroom', 'Lawn mower', 'Chainsaw',
  'Mechanisms', 'Ratchet, pawl', 'Gears', 'Pulleys', 'Sewing machine', 'Mechanical fan',
  'Air conditioning', 'Tools', 'Hammer', 'Jackhammer', 'Sawing', 'Power tool', 'Drill',
  'Rattle', 'Squeak', 'Squeal', 'Whir', 'Hum', 'Vibration', 'Throbbing', 'Rumble',
  'Clicking', 'Tick', 'Clatter', 'Creak', 'Scrape', 'Grind'
];
const VEHICLE_MECH = new Set(VEHICLE_MECH_NAMES.map(n => CLASSES.indexOf(n)).filter(i => i >= 0));
const INTERFERER = (() => {
  const s = new Set();
  for (let i = 0; i < CLASSES.indexOf('Animal'); i++) s.add(i);
  for (let i = CLASSES.indexOf('Music'); i < CLASSES.indexOf('Wind'); i++) s.add(i);
  ['Television', 'Radio', 'Silence', 'Whistling', 'Whistle'].forEach(n => {
    const i = CLASSES.indexOf(n);
    if (i >= 0) s.add(i);
  });
  return s;
})();

// ─── WAV + DSP helpers ───────────────────────────────────────────────────────
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
  if (!fmt || dataOff < 0) throw new Error('Malformed WAV');
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
      else if (fmt.bits === 32) v = dv.getInt32(off, true) / 2147483648;
      else if (fmt.bits === 8) v = (dv.getUint8(off) - 128) / 128;
      else throw new Error(`bits ${fmt.bits}`);
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
function cosine(a, b) {
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
  return (nA === 0 || nB === 0) ? 0 : dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// ─── model ───────────────────────────────────────────────────────────────────
let model;
function analyze(pcm) {
  return tf.tidy(() => {
    const [scores, embeddings] = model.predict(tf.tensor1d(pcm));
    return {
      emb: Array.from(tf.mean(embeddings, 0).dataSync()),
      meanScores: Array.from(tf.mean(scores, 0).dataSync())
    };
  });
}
function domainGate(meanScores) {
  let top1 = 0, veh = 0, intf = 0;
  for (let i = 0; i < meanScores.length; i++) {
    if (meanScores[i] > meanScores[top1]) top1 = i;
    if (VEHICLE_MECH.has(i) && meanScores[i] > veh) veh = meanScores[i];
    if (INTERFERER.has(i) && meanScores[i] > intf) intf = meanScores[i];
  }
  return { accepted: VEHICLE_MECH.has(top1) || (veh >= VEHICLE_SCORE_FLOOR && veh > intf), top1: CLASSES[top1] };
}

function runSession(pcm, fps) {
  const hits = new Map(), anomalies = new Set();
  let windows = 0, rejected = 0;
  for (let start = 0; start + WIN <= pcm.length || (start === 0 && pcm.length >= SR / 2); start += WIN) {
    const w = pcm.length >= start + WIN ? pcm.slice(start, start + WIN) : (() => { const p = new Float32Array(WIN); p.set(pcm.slice(start)); return p; })();
    windows++;
    if (rmsOf(w) < 0.01) { rejected++; continue; }
    const { emb, meanScores } = analyze(w);
    const gate = domainGate(meanScores);
    if (!gate.accepted) { rejected++; continue; }
    let best = -1, bestLabel = null;
    for (const fp of fps) { const s = cosine(emb, fp.yamnet_embedding); if (s > best) { best = s; bestLabel = fp.label; } }
    if (best >= ANOMALY_THRESHOLD) {
      const h = (hits.get(bestLabel) || 0) + 1;
      hits.set(bestLabel, h);
      if (h >= PERSISTENCE_HITS || best >= SINGLE_HIT_BYPASS_SCORE) anomalies.add(bestLabel);
    }
  }
  const mostlyRejected = windows > 0 && rejected / windows > 0.5;
  if (anomalies.size > 0) return { verdict: 'ANOMALY', labels: [...anomalies] };
  return { verdict: mostlyRejected ? 'REJECTED' : 'HEALTHY', labels: [] };
}

function pickFiles(dir, n) {
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.wav')).sort();
  const step = Math.max(1, Math.floor(all.length / n));
  return all.filter((_, i) => i % step === 0).slice(0, n).map(f => path.join(dir, f));
}

async function main() {
  console.log('[Setup] Loading YAMNet…');
  model = await tf.loadGraphModel(YAMNET_MODEL_URL, { fromTFHub: true });
  const d = tf.zeros([16000]); model.predict(d).forEach(t => t.dispose()); d.dispose();
  const fps = JSON.parse(fs.readFileSync(FP_CACHE, 'utf8'));
  console.log(`[Setup] ${fps.length} fingerprints loaded.\n`);

  const groups = [
    // [group label, directory, sessions, mustNotFlag]
    ['normal_engine_idle', path.join(DATASET, 'idle state', 'normal_engine_idle'), 12, true],
    ['normal_engine_startup', path.join(DATASET, 'startup state', 'normal_engine_startup'), 12, true],
    ['normal_brakes', path.join(DATASET, 'braking state', 'normal_brakes'), 12, true],
    // These fault classes now HAVE bucket references — recall checks (should flag)
    ['referenced fault: low_oil', path.join(DATASET, 'idle state', 'low_oil'), 4, false],
    ['referenced fault: serpentine_belt', path.join(DATASET, 'idle state', 'serpentine_belt'), 4, false],
    ['referenced fault: power_steering', path.join(DATASET, 'idle state', 'power_steering'), 4, false],
    // Still no references for these — informational
    ['unseen fault: worn_out_brakes', path.join(DATASET, 'braking state', 'worn_out_brakes'), 4, false],
    ['unseen fault: bad_ignition', path.join(DATASET, 'startup state', 'bad_ignition'), 4, false],
    ['unseen fault: dead_battery', path.join(DATASET, 'startup state', 'dead_battery'), 4, false],
  ];

  let sessions = 0, failures = 0;
  for (const [label, dir, n, mustNotFlag] of groups) {
    const files = pickFiles(dir, n);
    if (files.length === 0) { console.log(`(skip ${label} — no files at ${dir})`); continue; }
    const outcomes = { HEALTHY: 0, REJECTED: 0, ANOMALY: 0 };
    const flagged = [];
    for (const f of files) {
      let r;
      try {
        r = runSession(decodeWav(fs.readFileSync(f)), fps);
      } catch (e) { console.log(`  ! ${path.basename(f)}: ${e.message}`); continue; }
      sessions++;
      outcomes[r.verdict]++;
      if (r.verdict === 'ANOMALY') flagged.push(`${path.basename(f)} -> ${r.labels.join(';')}`);
    }
    const bad = mustNotFlag && outcomes.ANOMALY > 0;
    if (bad) failures += outcomes.ANOMALY;
    console.log(`■ ${label} (${files.length} sessions)${mustNotFlag ? ' [MUST NOT FLAG]' : ' [informational]'}`);
    console.log(`    HEALTHY ${outcomes.HEALTHY} | REJECTED ${outcomes.REJECTED} | ANOMALY ${outcomes.ANOMALY} ${bad ? ' ✗✗ REGRESSION' : ''}`);
    for (const x of flagged) console.log(`      flagged: ${x}`);
  }
  console.log(`\n═══ SWEEP RESULT: ${sessions} sessions, ${failures} healthy-audio false anomalies ═══`);
}

main().catch(e => { console.error(e); process.exit(1); });
