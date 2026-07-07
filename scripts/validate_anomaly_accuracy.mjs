/**
 * validate_anomaly_accuracy.mjs — Controlled validation of the anomaly detection pipeline.
 *
 * Replicates the EXACT production pipeline (datasetLoader.js + mlEmbeddingEngine.js +
 * audioFeatureExtractor.js windowing) in Node, then runs a controlled test matrix:
 *
 *   Negatives (must produce ZERO anomalies): silence, quiet room, ambient noise,
 *     TTS speech x4, TV-style dialogue (speech+music bed), synthetic music.
 *   Positives (must still be detected): the exact fault recordings the production
 *     fingerprints are built from (bearing, starter, piston, intake, misfire).
 *
 * For every 1-second window it evaluates BOTH decision rules side by side:
 *   CURRENT : cosine >= 0.75 vs fingerprints (production as of HEAD)
 *   GATED   : YAMNet 521-class domain gate -> cosine >= 0.75 -> 2-window persistence
 *
 * Usage: node scripts/validate_anomaly_accuracy.mjs [--verbose]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

const YAMNET_MODEL_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const FILES_TO_DOWNLOAD = [
  'alternator_bearing_fault_critical.wav',
  'BearingAlternator.wav',
  'intake_leak_low.wav',
  'misfire_detected_medium.wav',
  'MotorStarter.wav',
  'Piston.wav'
];
const SR = 16000;
const WIN = SR; // 1-second windows, same as production
const ANOMALY_THRESHOLD = 0.75; // production value — DO NOT CHANGE
const FP_CACHE = path.join(ROOT, 'scratch', 'validation_fingerprints_cache.json');

// ─── YAMNet class map ────────────────────────────────────────────────────────
function loadClassMap() {
  const csv = fs.readFileSync(path.join(__dirname, 'yamnet_class_map.csv'), 'utf8');
  const lines = csv.trim().split('\n').slice(1);
  return lines.map(raw => {
    const l = raw.replace(/\r$/, '');
    const m = l.match(/^\d+,[^,]+,(.*)$/);
    if (!m) throw new Error(`Unparseable class map line: ${JSON.stringify(l)}`);
    let name = m[1].trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    return name;
  });
}
const CLASSES = loadClassMap();
if (CLASSES.length !== 521) throw new Error(`Expected 521 classes, got ${CLASSES.length}`);

// Domain sets — mirror what will ship in src/lib/mlEmbeddingEngine.js
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
const idx = (name) => CLASSES.indexOf(name);
const VEHICLE_MECH = new Set(VEHICLE_MECH_NAMES.map(idx).filter(i => i >= 0));

// Human sounds: contiguous block from Speech(0) to just before Animal
const ANIMAL_START = idx('Animal');
// Music block: from Music to just before Wind
const MUSIC_START = idx('Music');
const WIND_START = idx('Wind');
const INTERFERER = new Set();
for (let i = 0; i < ANIMAL_START; i++) INTERFERER.add(i);
for (let i = MUSIC_START; i < WIND_START; i++) INTERFERER.add(i);
[idx('Television'), idx('Radio'), idx('Silence'),
 idx('Whistling'), idx('Whistle')].forEach(i => { if (i >= 0) INTERFERER.add(i); });

console.log(`[Setup] VEHICLE_MECH classes: ${VEHICLE_MECH.size}, INTERFERER classes: ${INTERFERER.size}`);

// ─── WAV decode + resample ───────────────────────────────────────────────────
function decodeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, false) !== 0x52494646) throw new Error('Not RIFF');
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(pos + 8, true),
        channels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        bits: dv.getUint16(pos + 22, true)
      };
    } else if (id === 'data') { dataOff = pos + 8; dataLen = size; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('Malformed WAV');
  const bytesPer = fmt.bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const off = dataOff + (i * fmt.channels + c) * bytesPer;
      if (off + bytesPer > dv.byteLength) break;
      let v;
      if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(off, true);
      else if (fmt.bits === 16) v = dv.getInt16(off, true) / 32768;
      else if (fmt.bits === 32) v = dv.getInt32(off, true) / 2147483648;
      else if (fmt.bits === 8) v = (dv.getUint8(off) - 128) / 128;
      else throw new Error(`Unsupported bits: ${fmt.bits}`);
      acc += v;
    }
    out[i] = acc / fmt.channels;
  }
  return { pcm: out, sampleRate: fmt.sampleRate };
}

function resampleTo16k(pcm, srIn) {
  if (srIn === SR) return pcm;
  const ratio = srIn / SR;
  const outLen = Math.floor(pcm.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio, l = Math.floor(x), r = Math.min(l + 1, pcm.length - 1);
    out[i] = pcm[l] * (1 - (x - l)) + pcm[r] * (x - l);
  }
  return out;
}

function rmsOf(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

// ─── YAMNet ──────────────────────────────────────────────────────────────────
let model = null;
async function loadModel() {
  console.log('[Setup] Loading YAMNet…');
  model = await tf.loadGraphModel(YAMNET_MODEL_URL, { fromTFHub: true });
  const d = tf.zeros([16000]);
  const [s, e, sp] = model.predict(d);
  s.dispose(); e.dispose(); sp.dispose(); d.dispose();
  console.log('[Setup] YAMNet ready.');
}

function analyzeWindow(pcm) {
  return tf.tidy(() => {
    const [scores, embeddings] = model.predict(tf.tensor1d(pcm));
    const emb = Array.from(tf.mean(embeddings, 0).dataSync());
    const meanScores = Array.from(tf.mean(scores, 0).dataSync());
    return { emb, meanScores };
  });
}

function cosine(a, b) {
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

function topK(scores, k = 5) {
  return scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, k)
    .map(([s, i]) => ({ name: CLASSES[i], idx: i, score: s }));
}

// Domain gate — the exact rule to be shipped
const VEHICLE_SCORE_FLOOR = 0.03;
function domainGate(meanScores) {
  let vehicleScore = 0, interfererScore = 0;
  for (const i of VEHICLE_MECH) if (meanScores[i] > vehicleScore) vehicleScore = meanScores[i];
  for (const i of INTERFERER) if (meanScores[i] > interfererScore) interfererScore = meanScores[i];
  const top1 = topK(meanScores, 1)[0];
  const accepted = VEHICLE_MECH.has(top1.idx) || (vehicleScore >= VEHICLE_SCORE_FLOOR && vehicleScore > interfererScore);
  return { accepted, vehicleScore, interfererScore, top1 };
}

// ─── Fingerprints (identical to datasetLoader.js) ────────────────────────────
async function buildFingerprints() {
  if (fs.existsSync(FP_CACHE)) {
    const parsed = JSON.parse(fs.readFileSync(FP_CACHE, 'utf8'));
    console.log(`[Fingerprints] Loaded ${parsed.length} from cache.`);
    return parsed;
  }
  const fps = [];
  for (const filename of FILES_TO_DOWNLOAD) {
    const res = await fetch(BUCKET + filename);
    if (!res.ok) { console.warn(`[Fingerprints] ${filename} -> HTTP ${res.status}, skipped`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const { pcm, sampleRate } = decodeWav(buf);
    const full = resampleTo16k(pcm, sampleRate);
    const step = WIN / 2;
    let n = 0;
    for (let start = 0; start + WIN <= full.length; start += step) {
      const chunk = full.slice(start, start + WIN);
      if (rmsOf(chunk) < 0.01) continue;
      const { emb } = analyzeWindow(chunk);
      fps.push({ label: filename.replace('.wav', '').replace(/_/g, ' '), source_file: filename, yamnet_embedding: emb });
      n++;
    }
    console.log(`[Fingerprints] ${filename}: ${n} chunks (${(full.length / SR).toFixed(1)}s @ ${sampleRate}Hz src)`);
  }
  fs.mkdirSync(path.dirname(FP_CACHE), { recursive: true });
  fs.writeFileSync(FP_CACHE, JSON.stringify(fps));
  return fps;
}

// ─── Synthetic negatives ─────────────────────────────────────────────────────
function synthSilence(sec) { return new Float32Array(SR * sec); }
function synthNoise(sec, amp) {
  const a = new Float32Array(SR * sec);
  for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 2 - 1) * amp;
  return a;
}
function synthMusic(sec) {
  // Simple chord progression with harmonics + vibrato — reads as music/synth to YAMNet
  const a = new Float32Array(SR * sec);
  const chords = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
  for (let i = 0; i < a.length; i++) {
    const t = i / SR;
    const chord = chords[Math.floor(t / 2) % chords.length];
    let v = 0;
    for (const f of chord) {
      const vib = 1 + 0.005 * Math.sin(2 * Math.PI * 5 * t);
      v += 0.5 * Math.sin(2 * Math.PI * f * vib * t) + 0.25 * Math.sin(2 * Math.PI * 2 * f * t) + 0.12 * Math.sin(2 * Math.PI * 3 * f * t);
    }
    const env = 0.7 + 0.3 * Math.sin(2 * Math.PI * t / 2);
    a[i] = v * env * 0.08;
  }
  return a;
}
function mix(a, b, gainB) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i % b.length] || 0) * gainB;
  return out;
}
function loadLocalWav(p) {
  const { pcm, sampleRate } = decodeWav(fs.readFileSync(p));
  return resampleTo16k(pcm, sampleRate);
}

// ─── Session simulation (mirrors audioFeatureExtractor + AudioRecorder) ─────
function runSession(name, pcm, fingerprints, expected) {
  const windows = [];
  for (let start = 0; start + WIN <= pcm.length; start += WIN) windows.push(pcm.slice(start, start + WIN));
  if (windows.length === 0) windows.push(pcm);

  const cur = { anomalies: new Map(), rejected: 0, windows: 0 };
  const gat = { anomalies: new Map(), rejected: 0, windows: 0 };
  const candidateHits = new Map(); // persistence state for gated rule
  const topSeen = new Map();

  for (const w of windows) {
    const rms = rmsOf(w);
    cur.windows++; gat.windows++;
    if (rms < 0.01) { cur.rejected++; gat.rejected++; continue; }

    const { emb, meanScores } = analyzeWindow(w);
    let best = -1, bestLabel = null;
    for (const fp of fingerprints) {
      const s = cosine(emb, fp.yamnet_embedding);
      if (s > best) { best = s; bestLabel = fp.label; }
    }
    const t5 = topK(meanScores, 3);
    for (const t of t5) topSeen.set(t.name, Math.max(topSeen.get(t.name) || 0, t.score));

    // CURRENT production rule
    if (best >= ANOMALY_THRESHOLD) cur.anomalies.set(bestLabel, Math.max(cur.anomalies.get(bestLabel) || 0, best));

    // GATED rule: domain gate -> cosine threshold -> persistence
    // (2 matched windows per session, or a single >= 0.90 high-confidence match)
    const gate = domainGate(meanScores);
    if (!gate.accepted) {
      gat.rejected++;
    } else if (best >= ANOMALY_THRESHOLD) {
      const hits = (candidateHits.get(bestLabel) || 0) + 1;
      candidateHits.set(bestLabel, hits);
      if (hits >= 2 || best >= 0.95) {
        gat.anomalies.set(bestLabel, Math.max(gat.anomalies.get(bestLabel) || 0, best));
      }
    }

    if (VERBOSE) {
      console.log(`    [${name}] rms=${rms.toFixed(3)} best=${best.toFixed(3)} (${bestLabel}) gate=${gate.accepted ? 'PASS' : 'REJECT'} veh=${gate.vehicleScore.toFixed(2)} intf=${gate.interfererScore.toFixed(2)} top1=${gate.top1.name}(${gate.top1.score.toFixed(2)})`);
    }
  }

  // Session verdict per AudioRecorder.handleAudioUpload semantics
  const verdict = (r) => {
    const mostlyRejected = r.windows > 0 && r.rejected / r.windows > 0.5;
    if (r.anomalies.size > 0) return `ANOMALY: ${[...r.anomalies.keys()].join('; ')}`;
    return mostlyRejected ? 'REJECTED (no vehicle audio)' : 'HEALTHY';
  };
  const curV = verdict(cur), gatV = verdict(gat);
  const ok = (v) => expected === 'anomaly' ? v.startsWith('ANOMALY') : !v.startsWith('ANOMALY');
  const top3 = [...topSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, s]) => `${n}(${s.toFixed(2)})`).join(', ');

  console.log(`\n■ ${name}  [expect: ${expected}]  (${windows.length} windows)`);
  console.log(`    YAMNet hears: ${top3 || 'n/a (all below RMS gate)'}`);
  console.log(`    CURRENT: ${curV}   ${ok(curV) ? '✓' : '✗ WRONG'}`);
  console.log(`    GATED:   ${gatV}   ${ok(gatV) ? '✓' : '✗ WRONG'}`);
  return { name, expected, current: curV, gated: gatV, currentOk: ok(curV), gatedOk: ok(gatV) };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  await loadModel();
  const fps = await buildFingerprints();
  if (fps.length === 0) throw new Error('No fingerprints — cannot validate');
  console.log(`[Fingerprints] Total: ${fps.length} chunk embeddings from ${new Set(fps.map(f => f.source_file)).size} files\n`);

  const ta = path.join(ROOT, 'scratch', 'testaudio');
  const af = path.resolve(ROOT, '..', 'audio_files');
  const cases = [];

  // Negatives
  cases.push(['silence (digital zero)', synthSilence(8), 'normal']);
  cases.push(['quiet room (very low noise)', synthNoise(8, 0.004), 'normal']);
  cases.push(['ambient room noise (audible)', synthNoise(8, 0.05), 'normal']);
  cases.push(['music (synth chords)', synthMusic(8), 'normal']);
  for (const f of ['speech_news', 'speech_conversation', 'speech_narration', 'speech_voice2']) {
    const p = path.join(ta, `${f}.wav`);
    if (fs.existsSync(p)) cases.push([`speech: ${f}`, loadLocalWav(p), 'normal']);
  }
  {
    const p = path.join(ta, 'speech_news.wav');
    if (fs.existsSync(p)) cases.push(['TV dialogue (speech + music bed)', mix(loadLocalWav(p), synthMusic(8), 0.35), 'normal']);
  }

  // Positives — the actual fault recordings the fingerprints derive from
  for (const f of ['BearingAlternator.wav', 'MotorStarter.wav', 'Piston.wav']) {
    const p = path.join(af, f);
    if (fs.existsSync(p)) cases.push([`fault: ${f}`, loadLocalWav(p), 'anomaly']);
  }
  for (const f of ['alternator_bearing_fault_critical.wav', 'intake_leak_low.wav', 'misfire_detected_medium.wav']) {
    const res = await fetch(BUCKET + f);
    if (res.ok) {
      const { pcm, sampleRate } = decodeWav(Buffer.from(await res.arrayBuffer()));
      cases.push([`fault: ${f}`, resampleTo16k(pcm, sampleRate), 'anomaly']);
    }
  }

  const results = [];
  for (const [name, pcm, expected] of cases) results.push(runSession(name, pcm, fps, expected));

  // Summary
  const stat = (key) => {
    const neg = results.filter(r => r.expected === 'normal');
    const pos = results.filter(r => r.expected === 'anomaly');
    const fp = neg.filter(r => !r[key]).length;
    const fn = pos.filter(r => !r[key]).length;
    return { fp, fn, negN: neg.length, posN: pos.length };
  };
  const c = stat('currentOk'), g = stat('gatedOk');
  console.log('\n═══════════════ SUMMARY ═══════════════');
  console.log(`CURRENT (HEAD):  false positives ${c.fp}/${c.negN}   false negatives ${c.fn}/${c.posN}`);
  console.log(`GATED  (fix):    false positives ${g.fp}/${g.negN}   false negatives ${g.fn}/${g.posN}`);
  fs.writeFileSync(path.join(ROOT, 'scratch', 'validation_results.json'), JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
