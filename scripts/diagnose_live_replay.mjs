/**
 * diagnose_live_replay.mjs — P0 RCA instrumentation.
 *
 * Reproduces the REAL failure condition: a reference anomaly PLAYED THROUGH A
 * SPEAKER into a phone microphone (offline harnesses previously fed exact PCM,
 * which passes; live replay does not — this measures why).
 *
 * Channel model applied to every bucket reference before inference:
 *   small-speaker bandpass (HP 300 Hz, LP 8 kHz) → room echo (25 ms/0.25 +
 *   60 ms/0.15) → room noise at 25 dB SNR → mild AGC-style soft compression →
 *   level to typical phone-mic RMS (~0.05)
 *
 * For EVERY window the exact production stages run with full telemetry:
 *   input RMS | domain-gate verdict + top-1 class | top-5 candidate matches |
 *   best anchor similarity | margin | per-window decision + rejection reason
 * ...followed by the exact session decision (fraction rule) and reason.
 *
 * Also runs channel-processed NEGATIVES (ambient noise, fan) so any subsequent
 * calibration is FP-guarded by the same harness.
 *
 * Usage: node scripts/diagnose_live_replay.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const TAU = 0.60, MARGIN = 0.05, FRACTION = 0.5, MIN_ACCEPTED = 4;
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';

// ─── class map + gate sets (identical to production) ────────────────
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

// ─── DSP ─────────────────────────────────────────────────────────────
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
// The speaker→room→mic channel
export function replayChannel(pcm, seed = 7) {
  let s = bandpass(pcm, 300, 8000);                 // small-speaker response
  const echo1 = Math.floor(SR * 0.025), echo2 = Math.floor(SR * 0.060);
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s[i] + (i >= echo1 ? s[i - echo1] * 0.25 : 0) + (i >= echo2 ? s[i - echo2] * 0.15 : 0);
  }
  const rnd = mulberry32(seed);
  const sigR = rmsOf(out), nR = sigR / Math.pow(10, 25 / 20); // 25 dB SNR room noise
  for (let i = 0; i < out.length; i++) out[i] += (rnd() * 2 - 1) * nR * 1.732;
  // level to typical phone-mic capture + mild soft compression (AGC-ish)
  const g = 0.05 / Math.max(1e-6, rmsOf(out));
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * g * 1.5) / 1.5;
  return out;
}

// ─── model + references (exact artifact the app ships) ──────────────
console.log('[RCA] Loading YAMNet + shipped artifact…');
const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'fingerprints_v9.json'), 'utf8'));
const dq = (q) => {
  const b = Buffer.from(q.b64, 'base64');
  const o = new Float32Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = q.min + b[i] * q.scale;
  return o;
};
const FAULTS = art.faults.map(f => ({ label: f.label, source: f.source_file, variant: f.variant, emb: dq(f.q) }));
const ANCH = art.anchors.map(a => ({ kind: a.kind, source: a.source, emb: dq(a.q) }));
console.log(`[RCA] ${FAULTS.length} fault embeddings / ${ANCH.length} anchors (artifact ${art.version})`);

function analyze(w) {
  return tf.tidy(() => {
    const [scores, embeddings] = model.predict(tf.tensor1d(w));
    return { emb: Array.from(tf.mean(embeddings, 0).dataSync()), sc: Array.from(tf.mean(scores, 0).dataSync()) };
  });
}
function gateVerdict(sc) {
  let t1 = 0, veh = 0, intf = 0;
  for (let i = 0; i < sc.length; i++) {
    if (sc[i] > sc[t1]) t1 = i;
    if (VEH.has(i) && sc[i] > veh) veh = sc[i];
    if (INTF.has(i) && sc[i] > intf) intf = sc[i];
  }
  const accepted = VEH.has(t1) || (!INTF.has(t1) && intf < 0.15) || (veh >= 0.03 && veh > intf);
  return { accepted, top1: CLASSES[t1], veh, intf };
}
const loopTo = (pcm, sec) => {
  const out = new Float32Array(SR * sec);
  for (let i = 0; i < out.length; i++) out[i] = pcm[i % pcm.length];
  return out;
};

// Live-pipeline parity (audioFeatureExtractor): 0.005 silence gate, then
// RMS-normalize to the reference factory's 0.05 target before inference.
function rmsNormalizeWin(pcm, target = 0.05) {
  const r = rmsOf(pcm);
  if (r < 1e-6) return pcm;
  const g = target / r;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i] * g));
  return out;
}

function diagnoseSession(name, pcm, verbose = true) {
  const perLabel = new Map();
  let accepted = 0, rejected = 0, windows = 0;
  const windowLog = [];
  for (let s = 0; s + WIN <= pcm.length; s += WIN) {
    const w = pcm.slice(s, s + WIN);
    windows++;
    const rms = rmsOf(w);
    if (rms < 0.005) { rejected++; windowLog.push({ t: s / SR, rms, stage: 'REJECT@rms' }); continue; }
    const { emb, sc } = analyze(rmsNormalizeWin(w));
    const g = gateVerdict(sc);
    if (!g.accepted) { rejected++; windowLog.push({ t: s / SR, rms, stage: `REJECT@gate top1=${g.top1} veh=${g.veh.toFixed(2)} intf=${g.intf.toFixed(2)}` }); continue; }
    accepted++;
    // top-5 candidates
    const ranked = FAULTS.map(f => [cosine(emb, f.emb), f]).sort((a, b) => b[0] - a[0]);
    const top5 = [];
    const seen = new Set();
    for (const [scv, f] of ranked) {
      if (seen.has(f.label)) continue;
      seen.add(f.label); top5.push(`${f.label.slice(0, 26)}=${scv.toFixed(3)}`);
      if (top5.length === 5) break;
    }
    let bestAnchor = 0, bestAnchorSrc = '';
    for (const a of ANCH) { const c = cosine(emb, a.emb); if (c > bestAnchor) { bestAnchor = c; bestAnchorSrc = a.source || a.kind; } }
    const [bf, bMatch] = ranked[0];
    const margin = bf - bestAnchor;
    let stage;
    if (bf < TAU) stage = `REJECT@threshold bf=${bf.toFixed(3)}`;
    else if (margin < MARGIN) stage = `REJECT@margin bf=${bf.toFixed(3)} anchor=${bestAnchor.toFixed(3)}(${bestAnchorSrc}) margin=${margin.toFixed(3)}`;
    else {
      stage = `CANDIDATE ${bMatch.label.slice(0, 26)} margin=${margin.toFixed(3)}`;
      const e = perLabel.get(bMatch.label) || 0;
      perLabel.set(bMatch.label, e + 1);
    }
    windowLog.push({ t: s / SR, rms, stage, top5: top5.join(' | ') });
  }
  const confirmed = [];
  for (const [l, hits] of perLabel) if (accepted >= MIN_ACCEPTED && hits / accepted >= FRACTION) confirmed.push(l);
  let sessionVerdict;
  if (confirmed.length) sessionVerdict = `ANOMALY: ${confirmed.join('; ')}`;
  else if (windows > 0 && rejected / windows > 0.5) sessionVerdict = 'REJECTED (mostly non-vehicle)';
  else {
    const best = [...perLabel.entries()].sort((a, b) => b[1] - a[1])[0];
    sessionVerdict = `HEALTHY (no label reached ${FRACTION * 100}% of ${accepted} accepted${best ? `; best: ${best[0].slice(0, 26)} ${best[1]}/${accepted}` : '; zero candidate windows'})`;
  }
  console.log(`\n■ ${name}`);
  console.log(`  SESSION: ${sessionVerdict}   [windows=${windows} accepted=${accepted} rejected=${rejected}]`);
  if (verbose) for (const wl of windowLog.slice(0, 8)) {
    console.log(`    t=${wl.t.toFixed(0).padStart(2)}s rms=${wl.rms.toFixed(3)} ${wl.stage}`);
    if (wl.top5) console.log(`        top5: ${wl.top5}`);
  }
  return { verdict: sessionVerdict, confirmed, accepted, rejected, windows };
}

// ─── Run: bucket references through the replay channel ──────────────
const refs = ['BearingAlternator.wav', 'alternator_bearing_fault_critical.wav', 'Piston.wav',
  'MotorStarter.wav', 'intake_leak_low.wav', 'misfire_detected_medium.wav',
  'timing_chain_rattle_high.wav', 'PowerSteeringPump.wav', 'SerpentineBelt.wav',
  'RockerArmAndValve.wav', 'Issue_with_Power_steering_or_low_oil_or_serpentine_belt_2.wav'];
console.log('\n════ LIVE-REPLAY SIMULATION (speaker→room→mic channel) — POSITIVES ════');
const results = [];
const scaleTo = (pcm, targetRms) => {
  const g = targetRms / Math.max(1e-6, rmsOf(pcm));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * g;
  return out;
};
for (const f of refs) {
  const res = await fetch(BUCKET + encodeURIComponent(f));
  if (!res.ok) { console.log(`  ! ${f} HTTP ${res.status}`); continue; }
  const pcm = decodeWav(Buffer.from(await res.arrayBuffer()));
  const chan = replayChannel(loopTo(pcm, 15));
  const verbose = f.toLowerCase().includes('alternator') || f.toLowerCase().includes('bearing');
  results.push({ f, ...diagnoseSession(`REPLAY ${f}`, chan, verbose) });
}

// QUIET-CAPTURE variants — phone mic with AGC disabled at distance
// (raw capture rms ~0.008, the field-failure condition)
console.log('\n════ QUIET-CAPTURE REPLAY (raw rms ≈ 0.008) — POSITIVES ════');
const quietResults = [];
for (const f of ['BearingAlternator.wav', 'alternator_bearing_fault_critical.wav', 'PowerSteeringPump.wav', 'SerpentineBelt.wav', 'Piston.wav']) {
  const res = await fetch(BUCKET + encodeURIComponent(f));
  if (!res.ok) continue;
  const pcm = decodeWav(Buffer.from(await res.arrayBuffer()));
  const quiet = scaleTo(replayChannel(loopTo(pcm, 15)), 0.008);
  quietResults.push({ f, ...diagnoseSession(`QUIET ${f}`, quiet, false) });
}

// ─── Negatives through the same channel (FP guard) ──────────────────
console.log('\n════ LIVE-REPLAY SIMULATION — NEGATIVES (FP guard) ════');
function noiseSig(sec, amp, seed) { const r = mulberry32(seed); const a = new Float32Array(SR * sec); for (let i = 0; i < a.length; i++) a[i] = (r() * 2 - 1) * amp; return a; }
function fanSim(sec) {
  const a = new Float32Array(SR * sec); let y = 0; const r = mulberry32(99);
  for (let i = 0; i < a.length; i++) { const t = i / SR; y = 0.95 * y + 0.05 * (r() * 2 - 1); a[i] = 0.035 * Math.sin(2 * Math.PI * 120 * t) + y * 0.45; }
  return a;
}
const negs = [
  ['ambient noise (channel)', replayChannel(noiseSig(15, 0.05, 3))],
  ['QUIET ambient noise (rms 0.008)', scaleTo(replayChannel(noiseSig(15, 0.05, 3)), 0.008)],
  ['fan (channel)', replayChannel(fanSim(15))],
  ['QUIET fan (rms 0.008)', scaleTo(replayChannel(fanSim(15)), 0.008)],
];
const ta = path.join(ROOT, 'scratch', 'testaudio');
if (fs.existsSync(path.join(ta, 'speech_news.wav'))) {
  negs.push(['TV speech (channel)', replayChannel(loopTo(decodeWav(fs.readFileSync(path.join(ta, 'speech_news.wav'))), 15))]);
}
let negFP = 0;
for (const [n, pcm] of negs) { const r = diagnoseSession(n, pcm, false); if (r.confirmed.length) negFP++; }

// ─── Summary ─────────────────────────────────────────────────────────
console.log('\n════ SUMMARY ════');
const det = results.filter(r => r.confirmed.length > 0);
console.log(`replay-channel positives detected: ${det.length}/${results.length}`);
for (const r of results) console.log(`  ${r.confirmed.length ? 'DETECT' : 'MISS  '} ${r.f}  -> ${r.verdict.slice(0, 90)}`);
console.log(`replay-channel negatives false-flagged: ${negFP}/${negs.length}`);
