/**
 * benchmark_discrimination.mjs — Stage-B calibration (margin rule).
 *
 * Evaluates the EXACT decision rule to be shipped, over a margin grid:
 *   domain gate -> bestFault >= 0.60 AND (bestFault - bestAnchor) >= MARGIN
 *   -> persistence (2 windows same label, or single window >= 0.95 that also passes margin)
 *
 * Held-out evaluation only: anchors were built from EVEN-numbered Kaggle clips;
 * this script evaluates ODD-numbered clips. Each clip is looped to a 12 s
 * session so the persistence rule is genuinely exercised (short-clip artifacts
 * previously masked healthy-idle false positives).
 *
 * Usage: node scripts/benchmark_discrimination.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const TAU = 0.60;
const MARGIN_GRID = [0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12];
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';

// ─── class map + domain sets (fan/AC REMOVED from accept list) ──────
const csv = fs.readFileSync(path.join(__dirname, 'yamnet_class_map.csv'), 'utf8');
const CLASSES = csv.trim().split('\n').slice(1).map(raw => {
  const l = raw.replace(/\r$/, '');
  const m = l.match(/^\d+,[^,]+,(.*)$/);
  let n = m[1].trim();
  if (n.startsWith('"') && n.endsWith('"')) n = n.slice(1, -1);
  return n;
});
const VEHICLE_MECH_NAMES = [
  'Vehicle', 'Motor vehicle (road)', 'Car', 'Vehicle horn, car horn, honking', 'Car alarm',
  'Power windows, electric windows', 'Skidding', 'Tire squeal', 'Car passing by',
  'Race car, auto racing', 'Truck', 'Air brake', 'Air horn, truck horn', 'Reversing beeps',
  'Bus', 'Motorcycle', 'Traffic noise, roadway noise',
  'Engine', 'Light engine (high frequency)', 'Medium engine (mid frequency)',
  'Heavy engine (low frequency)', 'Engine knocking', 'Engine starting', 'Idling',
  'Accelerating, revving, vroom', 'Lawn mower', 'Chainsaw',
  'Mechanisms', 'Ratchet, pawl', 'Gears', 'Pulleys', 'Sewing machine',
  'Tools', 'Hammer', 'Jackhammer', 'Sawing', 'Power tool', 'Drill',
  'Rattle', 'Squeak', 'Squeal', 'Whir', 'Hum', 'Vibration', 'Throbbing', 'Rumble',
  'Clicking', 'Tick', 'Clatter', 'Creak', 'Scrape', 'Grind'
];
const VEH = new Set(VEHICLE_MECH_NAMES.map(n => CLASSES.indexOf(n)).filter(i => i >= 0));
const INTF = (() => {
  const s = new Set();
  for (let i = 0; i < CLASSES.indexOf('Animal'); i++) s.add(i);
  for (let i = CLASSES.indexOf('Music'); i < CLASSES.indexOf('Wind'); i++) s.add(i);
  ['Television', 'Radio', 'Silence', 'Whistling', 'Whistle'].forEach(n => { const i = CLASSES.indexOf(n); if (i >= 0) s.add(i); });
  return s;
})();

// ─── WAV/DSP helpers ────────────────────────────────────────────────
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
function cosine(a, b) {
  let d = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
  return (nA === 0 || nB === 0) ? 0 : d / (Math.sqrt(nA) * Math.sqrt(nB));
}
function loopTo(pcm, seconds) {
  const out = new Float32Array(SR * seconds);
  if (pcm.length === 0) return out;
  for (let i = 0; i < out.length; i++) out[i] = pcm[i % pcm.length];
  return out;
}

// ─── load artifact ──────────────────────────────────────────────────
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'fingerprints_v9.json'), 'utf8'));
function dequant(q) {
  const bytes = Buffer.from(q.b64, 'base64');
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = q.min + bytes[i] * q.scale;
  return out;
}
const FAULTS = art.faults.map(f => ({ label: f.label, emb: dequant(f.q) }));
const HEALTHY = art.anchors.filter(a => a.kind === 'healthy').map(a => dequant(a.q));
const INTERF = art.anchors.filter(a => a.kind === 'interferer').map(a => dequant(a.q));
console.log(`[Bench] ${FAULTS.length} fault embeddings, ${HEALTHY.length} healthy anchors, ${INTERF.length} interferer anchors`);

// ─── model ──────────────────────────────────────────────────────────
const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });
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
  // Mirrors evaluateAudioDomain: mechanical top-1 | generic non-interferer
  // with negligible interferer evidence | dominant mechanical signature
  return VEH.has(t1) || (!INTF.has(t1) && intf < 0.15) || (veh >= 0.03 && veh > intf);
}

// Live-pipeline parity: windows are RMS-normalized to the reference target
// (audioFeatureExtractor does the same) after a 0.005 silence gate.
function rmsNormalize(pcm, target = 0.05) {
  const r = rmsOf(pcm);
  if (r < 1e-6) return pcm;
  const g = target / r;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i] * g));
  return out;
}

// Precompute per-window measurements for a session; decisions applied per margin later.
function measureSession(pcm) {
  const wins = [];
  for (let s = 0; s + WIN <= pcm.length; s += WIN) {
    const w = pcm.slice(s, s + WIN);
    if (rmsOf(w) < 0.005) { wins.push(null); continue; }
    const { emb, sc } = analyze(rmsNormalize(w));
    if (!gate(sc)) { wins.push(null); continue; }
    let bf = -1, bl = null;
    for (const f of FAULTS) { const c = cosine(emb, f.emb); if (c > bf) { bf = c; bl = f.label; } }
    let bh = 0;
    for (const h of HEALTHY) { const c = cosine(emb, h); if (c > bh) bh = c; }
    for (const h of INTERF) { const c = cosine(emb, h); if (c > bh) bh = c; }
    wins.push({ bf, bl, margin: bf - bh });
  }
  return wins;
}
function decide(wins, margin) {
  const hits = new Map();
  const anomalies = new Set();
  for (const w of wins) {
    if (!w) continue;
    if (w.bf >= TAU && w.margin >= margin) {
      const h = (hits.get(w.bl) || 0) + 1;
      hits.set(w.bl, h);
      if (h >= 2 || w.bf >= 0.95) anomalies.add(w.bl);
    }
  }
  return anomalies;
}

// ─── evaluation sets (ODD indices = held out from anchors) ──────────
function pickOdd(dir, n) {
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.wav'))
    .filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === 1; })
    .sort((a, b) => +a.match(/_(\d+)\.wav$/)[1] - +b.match(/_(\d+)\.wav$/)[1]);
  const step = Math.max(1, Math.floor(all.length / n));
  return all.filter((_, i) => i % step === 0).slice(0, n).map(f => path.join(dir, f));
}
function synthMusic(sec) {
  const a = new Float32Array(SR * sec);
  const chords = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6]];
  for (let i = 0; i < a.length; i++) {
    const t = i / SR, ch = chords[Math.floor(t / 2) % 3];
    let v = 0;
    for (const f of ch) v += 0.5 * Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t);
    a[i] = v * 0.08;
  }
  return a;
}
function noiseSig(sec, amp) {
  const a = new Float32Array(SR * sec);
  for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 2 - 1) * amp;
  return a;
}
const ta = path.join(ROOT, 'scratch', 'testaudio');
const loadWav = p => decodeWav(fs.readFileSync(p));
const mix = (a, b, g) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + (b[i % b.length] || 0) * g; return o; };

const sets = [];
sets.push(['healthy idle (held-out)', pickOdd(path.join(DATASET, 'idle state', 'normal_engine_idle'), 15).map(loadWav), 'neg']);
sets.push(['healthy startup (held-out)', pickOdd(path.join(DATASET, 'startup state', 'normal_engine_startup'), 10).map(loadWav), 'neg']);
sets.push(['healthy brakes (held-out)', pickOdd(path.join(DATASET, 'braking state', 'normal_brakes'), 10).map(loadWav), 'neg']);
function pinkNoise(sec, amp) {
  const a = new Float32Array(SR * sec);
  let y = 0;
  for (let i = 0; i < a.length; i++) { y = 0.85 * y + 0.15 * (Math.random() * 2 - 1); a[i] = y * amp * 4; }
  return a;
}
function fanSim(sec) {
  const a = new Float32Array(SR * sec);
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    const t = i / SR;
    y = 0.95 * y + 0.05 * (Math.random() * 2 - 1);
    a[i] = 0.035 * Math.sin(2 * Math.PI * 120 * t) + 0.018 * Math.sin(2 * Math.PI * 240 * t) + y * 0.45;
  }
  return a;
}
function sineTone(sec, hz, amp) {
  const a = new Float32Array(SR * sec);
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin(2 * Math.PI * hz * (i / SR));
  return a;
}
sets.push(['interferers (speech/TV/music/noise/fan/tone)', [
  loadWav(path.join(ta, 'speech_news.wav')),
  loadWav(path.join(ta, 'speech_conversation.wav')),
  mix(loadWav(path.join(ta, 'speech_news.wav')), synthMusic(8), 0.35),
  synthMusic(12),
  noiseSig(12, 0.05),
  noiseSig(12, 0.15),
  pinkNoise(12, 0.05),
  fanSim(12),
  sineTone(12, 300, 0.1),
], 'neg']);
sets.push(['fault power_steering (held-out)', pickOdd(path.join(DATASET, 'idle state', 'power_steering'), 12).map(loadWav), 'pos']);
sets.push(['fault serpentine_belt (held-out)', pickOdd(path.join(DATASET, 'idle state', 'serpentine_belt'), 12).map(loadWav), 'pos']);
sets.push(['fault low_oil (held-out)', pickOdd(path.join(DATASET, 'idle state', 'low_oil'), 12).map(loadWav), 'pos']);
// bucket originals (the references' own source recordings, mic-free sanity positives)
const bucketPos = [];
const bucketNames = [];
for (const f of ['BearingAlternator.wav', 'Piston.wav', 'MotorStarter.wav', 'intake_leak_low.wav',
                 'misfire_detected_medium.wav', 'timing_chain_rattle_high.wav',
                 'alternator_bearing_fault_critical.wav', 'PowerSteeringPump.wav',
                 'SerpentineBelt.wav', 'RockerArmAndValve.wav',
                 'Issue_with_Power_steering_or_low_oil_or_serpentine_belt_2.wav']) {
  const res = await fetch(BUCKET + encodeURIComponent(f));
  if (res.ok) { bucketPos.push(decodeWav(Buffer.from(await res.arrayBuffer()))); bucketNames.push(f); }
}
sets.push(['bucket reference originals', bucketPos, 'pos']);
console.log(`[Bench] bucket originals under test: ${bucketNames.join(', ')}`);

// ─── measure everything once ────────────────────────────────────────
const measured = [];
for (const [name, clips, kind] of sets) {
  const sessions = clips.map(c => measureSession(loopTo(c, 12)));
  measured.push({ name, kind, sessions });
  fs.writeFileSync(path.join(ROOT, 'scratch', 'bench_measurements.json'), JSON.stringify(measured));
  // margin distribution for calibration
  const margins = sessions.flat().filter(Boolean).map(w => w.margin);
  margins.sort((a, b) => a - b);
  const pct = q => margins.length ? margins[Math.floor(q * (margins.length - 1))].toFixed(3) : 'n/a';
  console.log(`[margins] ${name.padEnd(38)} n=${String(margins.length).padStart(4)}  p10=${pct(0.1)} p50=${pct(0.5)} p90=${pct(0.9)}`);
}

// ─── margin grid results ────────────────────────────────────────────
console.log(`\nτ=${TAU} | persistence: 2 windows (or >=0.95 single, margin still required)`);
console.log('margin | healthyFP | interfFP | faultDetect | bucketDetect');
for (const m of MARGIN_GRID) {
  let hN = 0, hFP = 0, iN = 0, iFP = 0, fN = 0, fDet = 0, bN = 0, bDet = 0;
  for (const { name, kind, sessions } of measured) {
    for (const wins of sessions) {
      const anomalies = decide(wins, m);
      if (kind === 'neg') {
        if (name.startsWith('interferers')) { iN++; if (anomalies.size) iFP++; }
        else { hN++; if (anomalies.size) hFP++; }
      } else if (name.startsWith('bucket')) { bN++; if (anomalies.size) bDet++; }
      else { fN++; if (anomalies.size) fDet++; }
    }
  }
  console.log(`${m.toFixed(2).padStart(6)} | ${String(hFP).padStart(4)}/${hN}  | ${String(iFP).padStart(3)}/${iN}  | ${String(fDet).padStart(5)}/${fN}    | ${String(bDet).padStart(5)}/${bN}`);
}
console.log('\nBENCHMARK COMPLETE');
