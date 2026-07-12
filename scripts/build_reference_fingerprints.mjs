/**
 * build_reference_fingerprints.mjs — OFFLINE REFERENCE FACTORY (Stage A)
 *
 * Replaces in-browser fingerprint generation with a curated, augmented,
 * versioned static artifact. Run on a dev machine whenever the reference
 * dataset changes; commit the output.
 *
 *   node scripts/build_reference_fingerprints.mjs
 *
 * Pipeline per bucket WAV:
 *   1. QC — decodable, >= 1.0 s, RMS >= 0.01, NOT a synthetic tone
 *      (YAMNet dominant class in {Sine wave, Harmonic, Chirp tone, ...} => rejected).
 *   2. Preprocess — mono 16 kHz, RMS loudness normalization.
 *   3. Augment — phone-band filter, noise @ 15 dB SNR, ±2% rate, room echo.
 *      (ffmpeg/librosa-equivalent chain implemented in dependency-free Node DSP;
 *       ffmpeg is not installed on the build machine.)
 *   4. Embed — YAMNet 1024-d mean embedding per 1 s chunk per variant.
 *
 * Negative anchors (the "compared to what?" the old engine lacked):
 *   - healthy: Kaggle normal_engine_idle / normal_engine_startup / normal_brakes
 *     (EVEN indices only — odd indices reserved for held-out evaluation)
 *   - interferer: TTS speech, synthetic music, broadband noise
 *
 * Output: public/fingerprints_v9.json — int8-quantized embeddings (base64),
 * ~1 KB per embedding. Decoded by src/lib/datasetLoader.js at runtime.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tf from '@tensorflow/tfjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 16000, WIN = SR;
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';
const LIST_URL = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/list/anomaly-patterns';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const OUT = path.join(ROOT, 'public', 'fingerprints_v9.json');

const MAX_CHUNKS_NUMBERED = 1; // 44 near-duplicate files of one class — 1 chunk each
const MAX_CHUNKS_SINGLE = 3;
const SYNTH_CLASSES = new Set(['Sine wave', 'Harmonic', 'Chirp tone', 'Sound effect', 'Theremin', 'Tuning fork', 'Sidetone', 'Dial tone', 'Synthesizer', 'Pulse']);

// ─── class map (for QC) ─────────────────────────────────────────────
const csv = fs.readFileSync(path.join(__dirname, 'yamnet_class_map.csv'), 'utf8');
const CLASSES = csv.trim().split('\n').slice(1).map(raw => {
  const l = raw.replace(/\r$/, '');
  const m = l.match(/^\d+,[^,]+,(.*)$/);
  let n = m[1].trim();
  if (n.startsWith('"') && n.endsWith('"')) n = n.slice(1, -1);
  return n;
});

// ─── WAV / DSP ──────────────────────────────────────────────────────
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
  return { pcm: out, sr: fmt.sampleRate };
}
function resampleTo(pcm, srIn, srOut) {
  if (srIn === srOut) return pcm;
  const ratio = srIn / srOut, outLen = Math.floor(pcm.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio, l = Math.floor(x), r = Math.min(l + 1, pcm.length - 1);
    out[i] = pcm[l] * (1 - (x - l)) + pcm[r] * (x - l);
  }
  return out;
}
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };

// FFmpeg-equivalent ops
function rmsNormalize(pcm, target = 0.05) {
  const r = rmsOf(pcm);
  if (r < 1e-6) return pcm;
  const g = target / r;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i] * g));
  return out;
}
function biquad(sig, b0, b1, b2, a1, a2) {
  const out = new Float32Array(sig.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const x0 = sig[i], y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}
function phoneBand(pcm) { // HP 100 Hz + LP 7 kHz — phone-mic frequency response sim
  const wH = 2 * Math.PI * 100 / SR, cH = Math.cos(wH), sH = Math.sin(wH) / 1.414, a0H = 1 + sH;
  let s = biquad(pcm, (1 + cH) / 2 / a0H, -(1 + cH) / a0H, (1 + cH) / 2 / a0H, -2 * cH / a0H, (1 - sH) / a0H);
  const wL = 2 * Math.PI * 7000 / SR, cL = Math.cos(wL), sL = Math.sin(wL) / 1.414, a0L = 1 + sL;
  return biquad(s, (1 - cL) / 2 / a0L, (1 - cL) / a0L, (1 - cL) / 2 / a0L, -2 * cL / a0L, (1 - sL) / a0L);
}
// Deterministic PRNG so the artifact is reproducible run-to-run
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function addNoise(pcm, snrDb, seed) {
  const rnd = mulberry32(seed);
  const sigR = rmsOf(pcm);
  const nR = sigR / Math.pow(10, snrDb / 20);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] + (rnd() * 2 - 1) * nR * 1.732;
  return out;
}
function rateShift(pcm, factor) { // asetrate-style pitch+tempo shift, re-fit to 1 s
  const shifted = resampleTo(pcm, SR, Math.round(SR * factor));
  const out = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) out[i] = shifted[i % shifted.length];
  return out;
}
function roomEcho(pcm, delayMs = 45, decay = 0.35) {
  const d = Math.floor(SR * delayMs / 1000);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] + (i >= d ? pcm[i - d] * decay : 0);
  return out;
}

// ─── YAMNet ─────────────────────────────────────────────────────────
console.log('[Factory] Loading YAMNet…');
const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });
function embed(w) {
  return tf.tidy(() => {
    const [, embeddings] = model.predict(tf.tensor1d(w));
    return Array.from(tf.mean(embeddings, 0).dataSync());
  });
}
function topClass(w) {
  return tf.tidy(() => {
    const [scores] = model.predict(tf.tensor1d(w));
    const sc = Array.from(tf.mean(scores, 0).dataSync());
    return CLASSES[sc.indexOf(Math.max(...sc))];
  });
}

// int8 quantization: preserves cosine to ~0.001
function quantize(emb) {
  let mn = Infinity, mx = -Infinity;
  for (const v of emb) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const scale = (mx - mn) / 255 || 1;
  const bytes = Buffer.alloc(emb.length);
  for (let i = 0; i < emb.length; i++) bytes[i] = Math.round((emb[i] - mn) / scale);
  return { min: +mn.toFixed(6), scale: +scale.toFixed(8), b64: bytes.toString('base64') };
}

function deriveMeta(filename) {
  const baseName = filename.replace(/\.wav$/i, '');
  const groupName = baseName.replace(/_\d+$/, '');
  const b = groupName.toLowerCase();
  let fault_type = groupName, severity = 'high';
  if (b.includes('critical')) severity = 'critical';
  else if (b.includes('medium') || b.includes('moderate')) severity = 'medium';
  else if (b.includes('low') && !b.includes('low_oil') && !b.includes('low oil')) severity = 'low';
  if (b.includes('power_steering') || b.includes('powersteeringpump') || b.includes('powersteer')) fault_type = 'power_steering';
  else if (b.includes('alternator') || (b.includes('bearing') && !b.includes('water'))) fault_type = 'alternator_bearing_fault';
  else if (b.includes('intake') || b.includes('leak')) fault_type = 'intake_leak';
  else if (b.includes('water_pump') || b.includes('waterpump')) fault_type = 'water_pump';
  else if (b.includes('motor') || b.includes('starter')) fault_type = 'motor_starter';
  else if (b.includes('piston') || b.includes('knock')) fault_type = 'piston_knock';
  else if (b.includes('serpentine') || (b.includes('belt') && !b.includes('power'))) fault_type = 'serpentine_belt';
  else if (b.includes('timing') || b.includes('chain')) fault_type = 'timing_chain';
  else if (b.includes('rocker') || b.includes('valve')) fault_type = 'rocker_valve';
  else if (b.includes('low_oil') || b.includes('oil')) fault_type = 'low_oil';
  return { label: groupName.replace(/_/g, ' '), fault_type, severity };
}

function selectChunks(full, maxChunks) {
  const step = WIN / 2;
  const cands = [];
  for (let s = 0; s + WIN <= full.length; s += step) {
    if (rmsOf(full.slice(s, s + WIN)) >= 0.01) cands.push(s);
  }
  if (cands.length <= maxChunks) return cands;
  if (maxChunks === 1) return [cands[Math.floor(cands.length / 2)]];
  const sel = [];
  for (let k = 0; k < maxChunks; k++) sel.push(cands[Math.floor(k * (cands.length - 1) / (maxChunks - 1))]);
  return sel;
}

// ─── Build fault references ─────────────────────────────────────────
const listRes = await fetch(LIST_URL, {
  method: 'POST',
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prefix: '', limit: 500 })
});
const wavs = (await listRes.json()).map(o => o.name).filter(n => n.toLowerCase().endsWith('.wav'));
console.log(`[Factory] Bucket: ${wavs.length} WAVs`);

const faults = [];
const qcLog = [];
let seedCounter = 1;
for (const name of wavs) {
  try {
    const buf = Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer());
    const { pcm, sr } = decodeWav(buf);
    if (pcm.length / sr < 1.0) { qcLog.push(`REJECT ${name}: shorter than 1.0s`); continue; }
    const full = resampleTo(pcm, sr, SR);
    if (rmsOf(full) < 0.01) { qcLog.push(`REJECT ${name}: near-silent`); continue; }
    // synthetic-tone QC on the middle second
    const mid = Math.max(0, Math.floor(full.length / 2) - WIN / 2);
    const probe = full.slice(mid, mid + WIN);
    if (probe.length === WIN) {
      const cls = topClass(probe);
      if (SYNTH_CLASSES.has(cls)) { qcLog.push(`REJECT ${name}: synthetic tone (YAMNet: ${cls})`); continue; }
    }
    const numbered = /_\d+\.wav$/i.test(name);
    const starts = selectChunks(full, numbered ? MAX_CHUNKS_NUMBERED : MAX_CHUNKS_SINGLE);
    const meta = deriveMeta(name);
    for (const s of starts) {
      const base = rmsNormalize(full.slice(s, s + WIN));
      const variants = [
        ['orig', base],
        ['band', rmsNormalize(phoneBand(base))],
        ['noise', addNoise(base, 15, seedCounter++)],
        ['rate+', rateShift(base, 1.02)],
        ['rate-', rateShift(base, 0.98)],
        ['echo', rmsNormalize(roomEcho(base))],
      ];
      for (const [vname, w] of variants) {
        faults.push({ ...meta, source_file: name, variant: vname, q: quantize(embed(w)) });
      }
    }
    qcLog.push(`OK     ${name}: ${starts.length} chunk(s) x 6 variants`);
  } catch (e) {
    qcLog.push(`REJECT ${name}: ${e.message}`);
  }
}

// ─── Build anchors ──────────────────────────────────────────────────
// EVEN indices only — odd indices are held out for the benchmark script.
const anchors = [];
function pickEven(dir, n) {
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.wav'))
    .filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === 0; })
    .sort((a, b) => +a.match(/_(\d+)\.wav$/)[1] - +b.match(/_(\d+)\.wav$/)[1]);
  const step = Math.max(1, Math.floor(all.length / n));
  return all.filter((_, i) => i % step === 0).slice(0, n).map(f => path.join(dir, f));
}
const healthySources = [
  [path.join(DATASET, 'idle state', 'normal_engine_idle'), 20],
  [path.join(DATASET, 'startup state', 'normal_engine_startup'), 10],
  [path.join(DATASET, 'braking state', 'normal_brakes'), 10],
];
for (const [dir, n] of healthySources) {
  for (const p of pickEven(dir, n)) {
    try {
      const { pcm, sr } = decodeWav(fs.readFileSync(p));
      const full = resampleTo(pcm, sr, SR);
      const starts = selectChunks(full, 1);
      for (const s of starts) {
        const base = rmsNormalize(full.slice(s, s + WIN));
        anchors.push({ kind: 'healthy', source: path.basename(p), q: quantize(embed(base)) });
        anchors.push({ kind: 'healthy', source: path.basename(p) + '#band', q: quantize(embed(rmsNormalize(phoneBand(base)))) });
      }
    } catch (e) { console.warn(`anchor skip ${p}: ${e.message}`); }
  }
}
// interferer anchors (backstop behind the domain gate)
const ta = path.join(ROOT, 'scratch', 'testaudio');
for (const f of ['speech_news', 'speech_conversation', 'speech_narration', 'speech_voice2']) {
  const p = path.join(ta, `${f}.wav`);
  if (!fs.existsSync(p)) continue;
  const { pcm, sr } = decodeWav(fs.readFileSync(p));
  const full = resampleTo(pcm, sr, SR);
  for (const s of selectChunks(full, 2)) {
    anchors.push({ kind: 'interferer', source: f, q: quantize(embed(rmsNormalize(full.slice(s, s + WIN)))) });
  }
}
{ // Broadband/tonal interferer anchors. The domain gate deliberately admits
  // generic acoustics (white noise, sine tones, rain-like broadband) so that
  // fault recordings classified as such aren't lost — these anchors are what
  // stops household noise from out-scoring the fault references at the
  // margin-matching stage.
  const rnd = mulberry32(42);
  const white = (amp) => {
    const a = new Float32Array(WIN);
    for (let i = 0; i < WIN; i++) a[i] = (rnd() * 2 - 1) * amp;
    return a;
  };
  anchors.push({ kind: 'interferer', source: 'whitenoise-quiet', q: quantize(embed(white(0.03))) });
  anchors.push({ kind: 'interferer', source: 'whitenoise', q: quantize(embed(white(0.08))) });
  anchors.push({ kind: 'interferer', source: 'whitenoise-loud', q: quantize(embed(white(0.2))) });
  // Pink-ish noise (1-pole lowpassed white) — rain / air vents / room tone
  {
    const a = new Float32Array(WIN);
    let y = 0;
    for (let i = 0; i < WIN; i++) { y = 0.85 * y + 0.15 * (rnd() * 2 - 1); a[i] = y * 0.35; }
    anchors.push({ kind: 'interferer', source: 'pinknoise', q: quantize(embed(a)) });
  }
  // Household fan sim: mains hum harmonics + brown-ish noise bed
  {
    const a = new Float32Array(WIN);
    let y = 0;
    for (let i = 0; i < WIN; i++) {
      const t = i / SR;
      y = 0.95 * y + 0.05 * (rnd() * 2 - 1);
      a[i] = 0.04 * Math.sin(2 * Math.PI * 120 * t) + 0.02 * Math.sin(2 * Math.PI * 240 * t) + y * 0.5;
    }
    anchors.push({ kind: 'interferer', source: 'fansim', q: quantize(embed(a)) });
  }
  // Pure test tone — TV test patterns, appliance beeps
  {
    const a = new Float32Array(WIN);
    for (let i = 0; i < WIN; i++) a[i] = 0.1 * Math.sin(2 * Math.PI * 440 * (i / SR));
    anchors.push({ kind: 'interferer', source: 'sine440', q: quantize(embed(a)) });
  }
  const music = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) {
    const t = i / SR;
    music[i] = 0.08 * (Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t) + 0.5 * Math.sin(2 * Math.PI * 523.2 * t));
  }
  anchors.push({ kind: 'interferer', source: 'synthmusic', q: quantize(embed(music)) });
}

// ─── Write artifact ─────────────────────────────────────────────────
const artifact = {
  version: 'v9',
  generated_by: 'scripts/build_reference_fingerprints.mjs',
  dim: 1024,
  quantization: 'int8: value = min + byte * scale',
  fault_count: faults.length,
  anchor_count: anchors.length,
  faults,
  anchors
};
fs.writeFileSync(OUT, JSON.stringify(artifact));
fs.writeFileSync(path.join(ROOT, 'scratch', 'factory_qc_log.txt'), qcLog.join('\n'));
console.log(`\n[Factory] QC log:`);
for (const l of qcLog.filter(l => l.startsWith('REJECT'))) console.log('  ' + l);
console.log(`[Factory] fault embeddings: ${faults.length} | anchors: ${anchors.length} (${anchors.filter(a => a.kind === 'healthy').length} healthy)`);
console.log(`[Factory] wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
