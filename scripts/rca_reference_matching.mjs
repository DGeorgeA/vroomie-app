/**
 * rca_reference_matching.mjs — PROMPT 2/3 ROOT-CAUSE AUDIT (measure only).
 *
 * Answers one question with numbers: when a known Supabase reference file is
 * replayed at the microphone, WHERE exactly does the match get lost?
 *
 * Runs two clearly separated tests per reference:
 *
 *   TEST A — DIGITAL      wav -> reference preprocessing -> YAMNet -> match
 *   TEST B — ACOUSTIC*    wav -> speaker/room/mic channel -> LIVE preprocessing
 *                             -> YAMNet -> match, at 3 playback distances
 *
 *   (*) TEST B is a CHANNEL SIMULATION, not a physical speaker-into-microphone
 *       recording. This process has no audio hardware. The simulation applies
 *       speaker bandwidth, room reflections, distance attenuation and noise —
 *       it is strictly more informative than a digital test and strictly less
 *       authoritative than a physical one. Labelled as such in all output.
 *
 * Emits, per file and per condition: sample rate, channels, duration, RMS,
 * peak, clipping, noise floor, SNR, spectral centroid, spectral rolloff,
 * embedding dims, top-5 candidates with similarities, top1-top2 margin,
 * fault-vs-anchor margin, per-window gate verdict, exact rejection reason and
 * the final session decision.
 *
 * CHANGES NOTHING. Reads the shipped artifact and mirrors the shipped
 * constants. Output: scratch/rca_reference_matching.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── SHIPPED OPERATING POINT (mirrored, not redefined) ────────────────────────
const SR = 16000, WIN = SR;
const TAU = 0.45, MARGIN = 0.04, FRACTION = 0.45, MIN_ACCEPTED = 3;
const SILENCE_GATE = 0.005;      // raw RMS below this = silence (live path)
const NORM_TARGET = 0.05;        // RMS normalization target (BOTH paths)
const VEHICLE_FLOOR = 0.03, INTERFERER_CEIL = 0.15;
const SESSION_SEC = 12;

const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const LIST_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/list/anomaly-patterns';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const EXCLUDED = new Set(['water_pump_failure_critical.wav']); // synthetic tone

const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const TESTAUDIO = path.join(ROOT, 'scratch', 'testaudio');

// ── YAMNet class map / gate sets ─────────────────────────────────────────────
const csv = fs.readFileSync(path.join(__dirname, 'yamnet_class_map.csv'), 'utf8');
const CLASSES = csv.trim().split('\n').slice(1).map(raw => {
  const line = raw.replace(/\r$/, '');            // CRLF-safe (known past bug)
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
  const START_HUMAN = CLASSES.indexOf('Speech'), END_HUMAN = CLASSES.indexOf('Chatter');
  for (let i = START_HUMAN; i <= END_HUMAN && i >= 0; i++) s.add(i);
  const START_MUS = CLASSES.indexOf('Music'), END_MUS = CLASSES.indexOf('Song');
  for (let i = START_MUS; i <= END_MUS && i >= 0; i++) s.add(i);
  for (const n of ['Television', 'Radio', 'Silence', 'Whistling', 'Whistle']) {
    const i = CLASSES.indexOf(n); if (i >= 0) s.add(i);
  }
  return s;
})();

// ── WAV decode ───────────────────────────────────────────────────────────────
function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
  let pos = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const sz = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10),
              rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    } else if (id === 'data') { dataOff = pos + 8; dataLen = sz; }
    pos += 8 + sz + (sz % 2);
  }
  if (!fmt || !dataOff) throw new Error('missing fmt/data');
  const n = fmt.bits === 16 ? dataLen / 2 : fmt.bits === 32 ? dataLen / 4 : dataLen;
  const inter = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (fmt.bits === 16) inter[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
    else if (fmt.bits === 32 && fmt.format === 3) inter[i] = buf.readFloatLE(dataOff + i * 4);
    else if (fmt.bits === 32) inter[i] = buf.readInt32LE(dataOff + i * 4) / 2147483648;
    else inter[i] = (buf.readUInt8(dataOff + i) - 128) / 128;
  }
  // downmix to mono
  let mono = inter;
  if (fmt.channels > 1) {
    mono = new Float32Array(Math.floor(n / fmt.channels));
    for (let i = 0; i < mono.length; i++) {
      let s = 0; for (let c = 0; c < fmt.channels; c++) s += inter[i * fmt.channels + c];
      mono[i] = s / fmt.channels;
    }
  }
  return { pcm: mono, rate: fmt.rate, channels: fmt.channels, bits: fmt.bits };
}

function resampleTo16k(pcm, from) {
  if (from === SR) return pcm;
  const ratio = from / SR, out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio, i0 = Math.floor(src), frac = src - i0;
    out[i] = (pcm[i0] || 0) * (1 - frac) + (pcm[i0 + 1] || 0) * frac;
  }
  return out;
}

// ── signal metrics ───────────────────────────────────────────────────────────
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
const peakOf = a => { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; };
const clipPct = a => { let c = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) >= 0.99) c++; return 100 * c / a.length; };

/** Noise floor = 10th-percentile frame RMS; SNR = 20log10(overallRMS/floor). */
function noiseFloorAndSnr(pcm, frame = 512) {
  const frames = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) frames.push(rmsOf(pcm.subarray(i, i + frame)));
  if (!frames.length) return { noiseFloor: 0, snrDb: 0 };
  frames.sort((a, b) => a - b);
  const floor = frames[Math.floor(frames.length * 0.10)] || 1e-9;
  const overall = rmsOf(pcm);
  return { noiseFloor: +floor.toFixed(6), snrDb: +(20 * Math.log10(overall / Math.max(floor, 1e-9))).toFixed(1) };
}

/** Iterative radix-2 FFT (in-place, power-of-two length). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Spectral centroid + 85% rolloff, averaged over Hann-windowed frames. */
function spectralShape(pcm, N = 1024) {
  let cSum = 0, rSum = 0, cnt = 0;
  for (let off = 0; off + N <= pcm.length; off += N) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = pcm[off + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im);
    const half = N / 2;
    const mag = new Float64Array(half);
    let total = 0;
    for (let i = 0; i < half; i++) { mag[i] = Math.hypot(re[i], im[i]); total += mag[i]; }
    if (total <= 1e-12) continue;
    let wsum = 0;
    for (let i = 0; i < half; i++) wsum += (i * SR / N) * mag[i];
    cSum += wsum / total;
    let acc = 0, roll = 0;
    for (let i = 0; i < half; i++) { acc += mag[i]; if (acc >= 0.85 * total) { roll = i * SR / N; break; } }
    rSum += roll; cnt++;
  }
  return cnt ? { centroidHz: Math.round(cSum / cnt), rolloff85Hz: Math.round(rSum / cnt) }
             : { centroidHz: 0, rolloff85Hz: 0 };
}

// ── acoustic channel simulation (speaker -> room -> mic) ─────────────────────
function biquad(sig, b0, b1, b2, a1, a2) {
  const out = new Float32Array(sig.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const x0 = sig[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}
function bandpass(pcm, hpHz, lpHz) {
  const hw = 2 * Math.PI * hpHz / SR, ha = Math.sin(hw) / 1.4, hc = Math.cos(hw);
  let a0 = 1 + ha;
  let s = biquad(pcm, (1 + hc) / 2 / a0, -(1 + hc) / a0, (1 + hc) / 2 / a0, -2 * hc / a0, (1 - ha) / a0);
  const lw = 2 * Math.PI * lpHz / SR, la = Math.sin(lw) / 1.4, lc = Math.cos(lw);
  a0 = 1 + la;
  return biquad(s, (1 - lc) / 2 / a0, (1 - lc) / a0, (1 - lc) / 2 / a0, -2 * lc / a0, (1 - la) / a0);
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/**
 * Simulates: speaker bandwidth limit -> two room reflections -> distance
 * attenuation -> ambient noise floor -> mic response.
 * `distanceM` scales attenuation and reflection strength.
 */
function replayChannel(pcm, distanceM = 1.0, seed = 7) {
  const rnd = mulberry32(seed);
  let s = bandpass(pcm, 250, 7500);                 // small speaker + phone mic band
  const out = new Float32Array(s.length);
  const d1 = Math.floor(SR * 0.013), d2 = Math.floor(SR * 0.027);
  const refl = Math.min(0.45, 0.18 * distanceM + 0.12);
  for (let i = 0; i < s.length; i++) {
    out[i] = s[i] + refl * (i > d1 ? s[i - d1] : 0) + (refl * 0.55) * (i > d2 ? s[i - d2] : 0);
  }
  const atten = 1 / (1 + 0.9 * distanceM);          // inverse-distance-ish
  const noiseAmp = 0.0016 * distanceM;
  for (let i = 0; i < out.length; i++) out[i] = out[i] * atten + (rnd() * 2 - 1) * noiseAmp;
  return out;
}

const loopTo = (pcm, sec) => {
  const need = SR * sec;
  if (pcm.length >= need) return pcm.subarray(0, need);
  const out = new Float32Array(need);
  for (let i = 0; i < need; i++) out[i] = pcm[i % pcm.length];
  return out;
};
function rmsNormalize(pcm, target = NORM_TARGET) {
  const r = rmsOf(pcm);
  if (r < 1e-6) return pcm;
  const g = target / r, out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i] * g));
  return out;
}

// ── model + artifact ─────────────────────────────────────────────────────────
console.log('[RCA] loading YAMNet...');
const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'fingerprints_v9.json'), 'utf8'));
// Artifact schema: {min, scale, b64} uint8 quantization (see build_reference_fingerprints.mjs)
const dq = (q) => {
  const b = Buffer.from(q.b64, 'base64');
  const o = new Float32Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = q.min + b[i] * q.scale;
  return o;
};
const FAULTS = art.faults.map(f => ({ label: f.label, family: f.fault_type || f.label, src: f.source_file, variant: f.variant, emb: dq(f.q) }));
const ANCH = art.anchors.map(a => ({ kind: a.kind, src: a.source, emb: dq(a.q) }));
console.log(`[RCA] artifact: ${FAULTS.length} fault embeddings, ${ANCH.length} anchors, dim=${FAULTS[0].emb.length}`);

const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
};

function embed(win) {
  return tf.tidy(() => {
    const [scores, emb] = model.predict(tf.tensor1d(win));
    const meanScores = scores.mean(0).arraySync();
    const meanEmb = emb.mean(0).arraySync();
    return { meanScores, meanEmb: Float32Array.from(meanEmb) };
  });
}

function gateVerdict(sc) {
  let top = 0, topI = 0;
  for (let i = 0; i < sc.length; i++) if (sc[i] > top) { top = sc[i]; topI = i; }
  let veh = 0, intf = 0;
  for (const i of VEH) if (sc[i] > veh) veh = sc[i];
  for (const i of INTF) if (sc[i] > intf) intf = sc[i];
  if (VEH.has(topI)) return { pass: true, reason: 'vehicle_top1', top: CLASSES[topI], veh, intf };
  if (!INTF.has(topI) && intf < INTERFERER_CEIL) return { pass: true, reason: 'generic_acoustic', top: CLASSES[topI], veh, intf };
  if (veh >= VEHICLE_FLOOR && veh > intf) return { pass: true, reason: 'vehicle_evidence', top: CLASSES[topI], veh, intf };
  return { pass: false, reason: INTF.has(topI) ? 'rejected_interferer_top1' : 'rejected_no_vehicle_evidence', top: CLASSES[topI], veh, intf };
}

/** Full per-window telemetry through the shipped decision path. */
function matchWindow(meanEmb) {
  const scored = FAULTS.map(f => ({ label: f.label, family: f.family, src: f.src, sim: cosine(meanEmb, f.emb) }))
                       .sort((a, b) => b.sim - a.sim);
  let bestAnchor = -1, anchorSrc = null;
  for (const a of ANCH) { const s = cosine(meanEmb, a.emb); if (s > bestAnchor) { bestAnchor = s; anchorSrc = `${a.kind}:${a.src}`; } }
  const top5 = scored.slice(0, 5).map(x => ({ label: x.label, family: x.family, sim: +x.sim.toFixed(4) }));
  const best = scored[0];
  // top1 vs top2 of DIFFERENT families (same-family variants are not competitors)
  const rival = scored.find(x => x.family !== best.family);
  return {
    top5,
    bestFault: +best.sim.toFixed(4), bestFamily: best.family, bestLabel: best.label,
    bestAnchor: +bestAnchor.toFixed(4), anchorSrc,
    faultAnchorMargin: +(best.sim - bestAnchor).toFixed(4),
    top1Top2Margin: rival ? +(best.sim - rival.sim).toFixed(4) : null,
    rivalFamily: rival ? rival.family : null,
    passesTau: best.sim >= TAU,
    passesMargin: (best.sim - bestAnchor) >= MARGIN,
  };
}

/** Run a full session exactly as the app would, capturing every stage. */
function runSession(pcm16k, { live }) {
  const sess = loopTo(pcm16k, SESSION_SEC);
  const windows = [];
  const fam = new Map();
  let accepted = 0, rejected = 0, silence = 0, candidates = 0;

  for (let off = 0; off + WIN <= sess.length; off += WIN) {
    let w = sess.subarray(off, off + WIN);
    const rawRms = rmsOf(w);
    if (live && rawRms < SILENCE_GATE) {
      silence++; rejected++;
      windows.push({ rawRms: +rawRms.toFixed(5), stage: 'silence_gate', reason: 'rejected_silence' });
      continue;
    }
    // BOTH paths normalize to the same target — this is the parity requirement
    const norm = rmsNormalize(w);
    const { meanScores, meanEmb } = embed(norm);
    const g = gateVerdict(meanScores);
    if (!g.pass) {
      rejected++;
      windows.push({ rawRms: +rawRms.toFixed(5), stage: 'domain_gate', reason: g.reason, top: g.top, veh: +g.veh.toFixed(3), intf: +g.intf.toFixed(3) });
      continue;
    }
    accepted++;
    const m = matchWindow(meanEmb);
    const isCand = m.passesTau && m.passesMargin;
    if (isCand) {
      candidates++;
      fam.set(m.bestFamily, (fam.get(m.bestFamily) || 0) + 1);
    }
    windows.push({
      rawRms: +rawRms.toFixed(5), stage: isCand ? 'candidate' : 'matched_below_rule',
      reason: isCand ? 'candidate' : (!m.passesTau ? `below_tau(${m.bestFault}<${TAU})` : `below_margin(${m.faultAnchorMargin}<${MARGIN})`),
      gate: g.reason, top: g.top, ...m,
    });
  }

  let confirmed = null, confFrac = 0;
  if (accepted >= MIN_ACCEPTED) {
    for (const [f, hits] of fam) {
      const frac = hits / accepted;
      if (frac >= FRACTION && frac > confFrac) { confirmed = f; confFrac = frac; }
    }
  }
  return {
    windowsTotal: windows.length, accepted, rejected, silenceRejects: silence, candidates,
    candidateFraction: accepted ? +(candidates / accepted).toFixed(3) : 0,
    familyVotes: Object.fromEntries(fam),
    confirmedFamily: confirmed, confirmedFraction: +confFrac.toFixed(3),
    decision: confirmed ? 'DETECTED' : (accepted < MIN_ACCEPTED ? 'ABORT_INSUFFICIENT_WINDOWS' : 'NO_ANOMALY'),
    windows,
  };
}

function signalReport(pcm, rate, channels) {
  const nf = noiseFloorAndSnr(pcm);
  const sh = spectralShape(pcm.length >= 1024 ? pcm : loopTo(pcm, 1));
  return {
    sampleRate: rate, channels, durationSec: +(pcm.length / rate).toFixed(2),
    rms: +rmsOf(pcm).toFixed(5), peak: +peakOf(pcm).toFixed(4), clippingPct: +clipPct(pcm).toFixed(3),
    noiseFloor: nf.noiseFloor, snrDb: nf.snrDb,
    centroidHz: sh.centroidHz, rolloff85Hz: sh.rolloff85Hz,
  };
}

// ── gather bucket files ──────────────────────────────────────────────────────
console.log('[RCA] listing bucket...');
const listRes = await fetch(LIST_URL, {
  method: 'POST',
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prefix: '', limit: 200, sortBy: { column: 'name', order: 'asc' } }),
});
const listing = await listRes.json();
const wavs = listing.filter(o => /\.wav$/i.test(o.name)).map(o => o.name);
console.log(`[RCA] ${wavs.length} WAVs in bucket (${EXCLUDED.size} explicitly excluded)`);

const PRIORITY = ['Piston.wav', 'PowerSteeringPump.wav', 'RockerArmAndValve.wav', 'BearingAlternator.wav', 'SerpentineBelt.wav'];
const ordered = [...PRIORITY.filter(f => wavs.includes(f)), ...wavs.filter(f => !PRIORITY.includes(f))];

const DISTANCES = [0.5, 1.0, 2.0];
const results = [];

for (const name of ordered) {
  if (EXCLUDED.has(name)) { console.log(`[RCA] SKIP ${name} (excluded: synthetic tone)`); continue; }
  let raw;
  try {
    const b = Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer());
    raw = decodeWav(b);
  } catch (e) { console.log(`[RCA] FAIL decode ${name}: ${e.message}`); continue; }

  const pcm16 = resampleTo16k(raw.pcm, raw.rate);
  const entry = { file: name, source: signalReport(raw.pcm, raw.rate, raw.channels), tests: {} };

  // TEST A — DIGITAL
  const A = runSession(pcm16, { live: false });
  entry.tests.digital = {
    signal: signalReport(rmsNormalize(pcm16), SR, 1),
    decision: A.decision, confirmedFamily: A.confirmedFamily, confirmedFraction: A.confirmedFraction,
    accepted: A.accepted, rejected: A.rejected, candidateFraction: A.candidateFraction,
    familyVotes: A.familyVotes,
    sampleWindow: A.windows.find(w => w.stage === 'candidate') || A.windows.find(w => w.top5) || A.windows[0],
  };

  // TEST B — SIMULATED ACOUSTIC at three distances
  entry.tests.acoustic = {};
  for (const d of DISTANCES) {
    const ch = replayChannel(pcm16, d, 7);
    const B = runSession(ch, { live: true });
    entry.tests.acoustic[`${d}m`] = {
      signal: signalReport(ch, SR, 1),
      decision: B.decision, confirmedFamily: B.confirmedFamily, confirmedFraction: B.confirmedFraction,
      accepted: B.accepted, rejected: B.rejected, silenceRejects: B.silenceRejects,
      candidateFraction: B.candidateFraction, familyVotes: B.familyVotes,
      sampleWindow: B.windows.find(w => w.stage === 'candidate') || B.windows.find(w => w.top5) || B.windows[0],
      rejectionBreakdown: B.windows.reduce((m, w) => { m[w.reason] = (m[w.reason] || 0) + 1; return m; }, {}),
    };
  }

  const anyAcoustic = DISTANCES.some(d => entry.tests.acoustic[`${d}m`].decision === 'DETECTED');
  console.log(`  ${name.padEnd(42)} digital=${A.decision === 'DETECTED' ? 'OK ' : 'MISS'} acoustic=${anyAcoustic ? 'OK ' : 'MISS'} fam=${A.confirmedFamily || '-'}`);
  results.push(entry);
}

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
console.log('[RCA] negative controls...');
const negatives = [];
function synth(kind, sec = SESSION_SEC) {
  const n = SR * sec, out = new Float32Array(n), rnd = mulberry32(11);
  if (kind === 'silence') { for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.0004; }
  else if (kind === 'white_noise') { for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.08; }
  else if (kind === 'pink_noise') {
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) { const w = rnd() * 2 - 1; b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.950 * b2 + w * 0.048; out[i] = (b0 + b1 + b2) * 0.6; }
  } else if (kind === 'fan') {
    let lp = 0;
    for (let i = 0; i < n; i++) { lp = 0.995 * lp + 0.005 * (rnd() * 2 - 1); out[i] = lp * 6 + 0.004 * Math.sin(2 * Math.PI * 48 * i / SR); }
  } else if (kind === 'traffic') {
    let lp = 0;
    for (let i = 0; i < n; i++) { lp = 0.9985 * lp + 0.0015 * (rnd() * 2 - 1); out[i] = lp * 9 + 0.02 * Math.sin(2 * Math.PI * 90 * i / SR) * (0.6 + 0.4 * Math.sin(2 * Math.PI * i / (SR * 3))); }
  } else if (kind === 'music') {
    const notes = [261.6, 329.6, 392.0, 523.3];
    for (let i = 0; i < n; i++) {
      const t = i / SR, seg = Math.floor(t * 2) % notes.length, f = notes[seg];
      out[i] = 0.16 * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t));
    }
  }
  return out;
}
const negSets = [['silence', synth('silence')], ['white_noise', synth('white_noise')], ['pink_noise', synth('pink_noise')],
                 ['fan', synth('fan')], ['traffic', synth('traffic')], ['music_synth', synth('music')]];
if (fs.existsSync(TESTAUDIO)) {
  for (const f of fs.readdirSync(TESTAUDIO).filter(f => /\.wav$/i.test(f))) {
    try { const d = decodeWav(fs.readFileSync(path.join(TESTAUDIO, f))); negSets.push([`speech:${f}`, resampleTo16k(d.pcm, d.rate)]); } catch {}
  }
}
// held-out healthy vehicles — the most important negatives
if (fs.existsSync(DATASET)) {
  for (const [lbl, sub] of [['healthy_idle', path.join(DATASET, 'idle state', 'normal_engine_idle')],
                            ['healthy_startup', path.join(DATASET, 'startup state', 'normal_engine_startup')]]) {
    if (!fs.existsSync(sub)) continue;
    const files = fs.readdirSync(sub).filter(f => /\.wav$/i.test(f)).filter((_, i) => i % 2 === 1).slice(0, 10);
    files.forEach((f, i) => {
      try { const d = decodeWav(fs.readFileSync(path.join(sub, f))); negSets.push([`${lbl}#${i}`, resampleTo16k(d.pcm, d.rate)]); } catch {}
    });
  }
}
for (const [label, pcm] of negSets) {
  const S = runSession(pcm, { live: true });
  const falsePos = S.decision === 'DETECTED';
  negatives.push({ label, decision: S.decision, confirmedFamily: S.confirmedFamily, accepted: S.accepted,
                   rejected: S.rejected, candidateFraction: S.candidateFraction, falsePositive: falsePos,
                   signal: signalReport(pcm, SR, 1) });
  if (falsePos) console.log(`  !! FALSE POSITIVE ${label} -> ${S.confirmedFamily}`);
}
console.log(`[RCA] negatives: ${negatives.filter(n => n.falsePositive).length}/${negatives.length} false positives`);

// ── PREPROCESSING PARITY (measured, not read) ────────────────────────────────
const parityFile = ordered.find(f => !EXCLUDED.has(f)) || wavs[0];
const pBuf = Buffer.from(await (await fetch(BUCKET + encodeURIComponent(parityFile))).arrayBuffer());
const pRaw = decodeWav(pBuf);
const p16 = resampleTo16k(pRaw.pcm, pRaw.rate);
const refWin = rmsNormalize(p16.subarray(0, WIN));
const liveWin = rmsNormalize(replayChannel(p16, 1.0, 7).subarray(0, WIN));
const refEmb = embed(refWin), liveEmb = embed(liveWin);
const parity = {
  file: parityFile,
  referencePath: { sampleRate: SR, channels: 1, windowSamples: WIN, normTarget: NORM_TARGET,
                   measuredRmsAfterNorm: +rmsOf(refWin).toFixed(5), embeddingDims: refEmb.meanEmb.length,
                   scoreDims: refEmb.meanScores.length },
  livePath: { sampleRate: SR, channels: 1, windowSamples: WIN, normTarget: NORM_TARGET,
              measuredRmsAfterNorm: +rmsOf(liveWin).toFixed(5), embeddingDims: liveEmb.meanEmb.length,
              scoreDims: liveEmb.meanScores.length },
  rmsDelta: +(rmsOf(refWin) - rmsOf(liveWin)).toFixed(6),
  embeddingCosineRefVsLive: +cosine(refEmb.meanEmb, liveEmb.meanEmb).toFixed(4),
  note: 'Both paths: mono -> 16 kHz -> RMS-normalize to 0.05 -> 1 s window -> YAMNet. No FFT/Mel/MFCC stage exists in this architecture; YAMNet consumes normalized PCM directly, so Mel/MFCC parity questions are not applicable.',
};

const out = {
  generatedBy: 'scripts/rca_reference_matching.mjs',
  disclaimer: 'TEST B is a SIMULATED acoustic channel (speaker band + room reflections + distance attenuation + noise). It is NOT a physical speaker-into-microphone recording; this process has no audio hardware.',
  operatingPoint: { TAU, MARGIN, FRACTION, MIN_ACCEPTED, SILENCE_GATE, NORM_TARGET, VEHICLE_FLOOR, INTERFERER_CEIL, SESSION_SEC },
  artifact: { faults: FAULTS.length, anchors: ANCH.length, embeddingDims: FAULTS[0].emb.length,
              families: [...new Set(FAULTS.map(f => f.family))].sort() },
  parity, results, negatives,
};
fs.writeFileSync(path.join(ROOT, 'scratch', 'rca_reference_matching.json'), JSON.stringify(out, null, 2));

const digOK = results.filter(r => r.tests.digital.decision === 'DETECTED').length;
const acOK = results.filter(r => DISTANCES.some(d => r.tests.acoustic[`${d}m`].decision === 'DETECTED')).length;
console.log(`\n[RCA] DIGITAL detected ${digOK}/${results.length} | SIM-ACOUSTIC detected ${acOK}/${results.length} | negatives FP ${negatives.filter(n => n.falsePositive).length}/${negatives.length}`);
console.log('[RCA] wrote scratch/rca_reference_matching.json');
