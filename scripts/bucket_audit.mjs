/**
 * bucket_audit.mjs — evidence-gathering for the RCA report. READ-ONLY audit:
 *  1. Every WAV in anomaly-patterns: sample rate, duration, RMS, YAMNet top classes,
 *     synthetic-tone detection.
 *  2. Class separability: per-class centroid cosine matrix.
 *  3. Interferer probes (speech/TV/music/noise) vs every class: max cosine
 *     (= the "confidence" the old engine displayed).
 *  4. Real-recording recall gap: raw Kaggle fault clips vs bucket references.
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
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbGRta2hjZHRscXhhb3B4bGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM4NDMwNDYsImV4cCI6MjA3OTQxOTA0Nn0.v3lbUrwF6ZDPn-z8NYE01h7Fs1cTa1TAxQlTAsY3xbU';

const csv = fs.readFileSync(path.join(ROOT, 'scripts', 'yamnet_class_map.csv'), 'utf8');
const CLASSES = csv.trim().split('\n').slice(1).map(raw => {
  const l = raw.replace(/\r$/, '');
  const m = l.match(/^\d+,[^,]+,(.*)$/);
  let n = m[1].trim();
  if (n.startsWith('"') && n.endsWith('"')) n = n.slice(1, -1);
  return n;
});

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
  return { pcm: out, sr: fmt.sampleRate };
}
function resample(pcm, srIn) {
  if (srIn === SR) return pcm;
  const ratio = srIn / SR, outLen = Math.floor(pcm.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio, l = Math.floor(x), r = Math.min(l + 1, pcm.length - 1);
    out[i] = pcm[l] * (1 - (x - l)) + pcm[r] * (x - l);
  }
  return out;
}
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
const cosine = (a, b) => {
  let d = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
  return (nA === 0 || nB === 0) ? 0 : d / (Math.sqrt(nA) * Math.sqrt(nB));
};

const model = await tf.loadGraphModel('https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1', { fromTFHub: true });
function analyze(w) {
  return tf.tidy(() => {
    const [scores, embeddings] = model.predict(tf.tensor1d(w));
    return {
      emb: Array.from(tf.mean(embeddings, 0).dataSync()),
      sc: Array.from(tf.mean(scores, 0).dataSync())
    };
  });
}
const top = (sc, k) => sc.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, k).map(([s, i]) => `${CLASSES[i]}(${s.toFixed(2)})`);

// ── 1. Per-file audit ─────────────────────────────────────────────
const listRes = await fetch(LIST_URL, {
  method: 'POST',
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prefix: '', limit: 500 })
});
const wavs = (await listRes.json()).map(o => o.name).filter(n => n.toLowerCase().endsWith('.wav'));
console.log(`\n════ 1. FILE AUDIT (${wavs.length} WAVs) ════`);
const byLabel = new Map(); // label -> [window embeddings]
const fileMeta = [];
for (const name of wavs) {
  const buf = Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer());
  const { pcm, sr } = decodeWav(buf);
  const full = resample(pcm, sr);
  const label = name.replace(/\.wav$/i, '').replace(/_\d+$/, '').replace(/_/g, ' ');
  const embs = [];
  const classCounts = new Map();
  for (let s = 0; s + WIN <= full.length; s += WIN) {
    const w = full.slice(s, s + WIN);
    if (rmsOf(w) < 0.01) continue;
    const { emb, sc } = analyze(w);
    embs.push(emb);
    const t1 = sc.indexOf(Math.max(...sc));
    classCounts.set(CLASSES[t1], (classCounts.get(CLASSES[t1]) || 0) + 1);
  }
  if (!byLabel.has(label)) byLabel.set(label, []);
  byLabel.get(label).push(...embs);
  const domClasses = [...classCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, n]) => `${c}×${n}`).join(', ');
  const synthetic = [...classCounts.keys()].every(c => ['Sine wave', 'Harmonic', 'Chirp tone', 'Sound effect', 'Theremin', 'Tuning fork', 'Sidetone', 'Dial tone', 'Synthesizer'].includes(c)) && classCounts.size > 0;
  fileMeta.push({ name, sr, dur: (pcm.length / sr).toFixed(1), rms: rmsOf(full).toFixed(3), domClasses, synthetic });
}
// print compact: group the 44 numbered files
const numbered = fileMeta.filter(f => /_\d+\.wav$/i.test(f.name));
const singles = fileMeta.filter(f => !/_\d+\.wav$/i.test(f.name));
for (const f of singles) console.log(`  ${f.synthetic ? '⚠️SYNTH' : '      '} ${f.name}  ${f.sr}Hz ${f.dur}s rms=${f.rms}  hears: ${f.domClasses}`);
console.log(`  — numbered power-steering set: ${numbered.length} files —`);
const synthCount = numbered.filter(f => f.synthetic).length;
const domAll = new Map();
for (const f of numbered) for (const part of f.domClasses.split(', ')) {
  const c = part.replace(/×\d+$/, '');
  domAll.set(c, (domAll.get(c) || 0) + 1);
}
console.log(`    synthetic-tone files: ${synthCount}/${numbered.length}`);
console.log(`    dominant YAMNet classes across set: ${[...domAll.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c}×${n}`).join(', ')}`);
console.log(`    sample rates: ${[...new Set(numbered.map(f => f.sr))].join(',')} | durations: ${Math.min(...numbered.map(f => +f.dur))}-${Math.max(...numbered.map(f => +f.dur))}s`);

// ── 2. Class separability (centroid cosine matrix) ────────────────
console.log(`\n════ 2. CLASS SEPARABILITY (centroid cosine) ════`);
const labels = [...byLabel.keys()];
const centroids = labels.map(l => {
  const embs = byLabel.get(l);
  const c = new Float64Array(1024);
  for (const e of embs) for (let i = 0; i < 1024; i++) c[i] += e[i];
  for (let i = 0; i < 1024; i++) c[i] /= embs.length;
  return c;
});
for (let i = 0; i < labels.length; i++) {
  const row = [];
  for (let j = 0; j < labels.length; j++) {
    if (i === j) continue;
    row.push([cosine(centroids[i], centroids[j]), labels[j]]);
  }
  row.sort((a, b) => b[0] - a[0]);
  console.log(`  ${labels[i].slice(0, 42).padEnd(42)} closest: ${row[0][1].slice(0, 30)} @ ${row[0][0].toFixed(3)}`);
}

// ── 3. Interferer probes vs references ─────────────────────────────
console.log(`\n════ 3. INTERFERER PROBES vs REFERENCES (max window cosine) ════`);
const ta = path.join(ROOT, 'scratch', 'testaudio');
function synthMusic(sec) {
  const a = new Float32Array(SR * sec);
  const chords = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6]];
  for (let i = 0; i < a.length; i++) {
    const t = i / SR;
    const ch = chords[Math.floor(t / 2) % 3];
    let v = 0;
    for (const f of ch) v += 0.5 * Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t);
    a[i] = v * 0.08;
  }
  return a;
}
function noise(sec, amp) {
  const a = new Float32Array(SR * sec);
  for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 2 - 1) * amp;
  return a;
}
const loadWav = p => { const { pcm, sr } = decodeWav(fs.readFileSync(p)); return resample(pcm, sr); };
const mix = (a, b, g) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + (b[i % b.length] || 0) * g; return o; };

const probes = [
  ['speech (TTS news)', loadWav(path.join(ta, 'speech_news.wav'))],
  ['TV (speech+music)', mix(loadWav(path.join(ta, 'speech_news.wav')), synthMusic(8), 0.35)],
  ['music (synth)', synthMusic(8)],
  ['ambient noise', noise(8, 0.05)],
];
// per-file (not centroid) max — this is what nearest-neighbor actually sees
const allRefEmbs = [];
for (const l of labels) for (const e of byLabel.get(l)) allRefEmbs.push([l, e]);
for (const [pname, pcm] of probes) {
  const best = new Map();
  for (let s = 0; s + WIN <= pcm.length; s += WIN) {
    const w = pcm.slice(s, s + WIN);
    if (rmsOf(w) < 0.01) continue;
    const { emb } = analyze(w);
    for (const [l, re] of allRefEmbs) {
      const c = cosine(emb, re);
      if (c > (best.get(l) || 0)) best.set(l, c);
    }
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`  ${pname.padEnd(20)} top: ${ranked.map(([l, c]) => `${l.slice(0, 38)}@${c.toFixed(3)}`).join(' | ')}`);
}

// ── 4. Real-recording recall gap ────────────────────────────────────
console.log(`\n════ 4. REAL RAW RECORDINGS vs REFERENCES (max cosine to own class) ════`);
const DS = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const realSets = [
  ['raw power_steering', path.join(DS, 'idle state', 'power_steering'), 'Issue with Power steering or low oil or serpentine belt'],
  ['raw serpentine_belt', path.join(DS, 'idle state', 'serpentine_belt'), 'Issue with Power steering or low oil or serpentine belt'],
  ['raw low_oil', path.join(DS, 'idle state', 'low_oil'), 'Issue with Power steering or low oil or serpentine belt'],
  ['raw normal_idle', path.join(DS, 'idle state', 'normal_engine_idle'), null],
];
for (const [name, dir, ownLabel] of realSets) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.wav')).slice(0, 5);
  const scores = [];
  for (const f of files) {
    const pcm = loadWav(path.join(dir, f));
    let bestOwn = 0, bestAny = 0, bestAnyLabel = '';
    for (let s = 0; s + WIN <= pcm.length; s += WIN) {
      const w = pcm.slice(s, s + WIN);
      if (rmsOf(w) < 0.01) continue;
      const { emb } = analyze(w);
      for (const [l, re] of allRefEmbs) {
        const c = cosine(emb, re);
        if (ownLabel && l === ownLabel && c > bestOwn) bestOwn = c;
        if (c > bestAny) { bestAny = c; bestAnyLabel = l; }
      }
    }
    scores.push({ f, bestOwn: bestOwn.toFixed(3), bestAny: bestAny.toFixed(3), bestAnyLabel: bestAnyLabel.slice(0, 30) });
  }
  console.log(`  ${name}:`);
  for (const s of scores) console.log(`     ${s.f.slice(0, 44).padEnd(44)} own=${ownLabel ? s.bestOwn : ' n/a '} best=${s.bestAny} (${s.bestAnyLabel})`);
}
console.log('\nAUDIT COMPLETE');
