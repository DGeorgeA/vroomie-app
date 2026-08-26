/**
 * review_constellation_shipped.mjs — pre-ship review measurements for the
 * constellation fast path, against the SHIPPED index (13 refs), not the
 * 6-ref prototype the thresholds were derived from.
 *
 * Flaws under test:
 *  F1. Threshold provenance: negatives/positives re-measured on the shipped
 *      artifact via the shipped hydrate/match code path.
 *  F2. Short-reference bias: normalized = score/queryHashes cannot reach 0.05
 *      when the reference is much shorter than the listen window. Measures
 *      per-ref achievable normalized for the 1.5 s PS variants, and evaluates
 *      the corrected metric normalized' = score / min(queryHashes, refHashes).
 *  F3. Single-play (non-looped) replay: user plays a 1.5-2 s file ONCE within
 *      a 5 s listen — does the match still fire?
 *  F4. Ambiguity: best-vs-second ratio for true matches (near-duplicate PS
 *      variants are in the index — do they threaten the top-1?).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeConstellationHashes, hydrateIndex, matchHashes, SR } from '../src/lib/constellationMatcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC10 = path.resolve(ROOT, '..', 'audio_files', 'extended_10s');
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const TESTAUDIO = path.join(ROOT, 'scratch', 'testaudio');
const BUCKET = 'https://bdldmkhcdtlqxaopxlam.supabase.co/storage/v1/object/public/anomaly-patterns/';

function decodeWav(buf) {
  let pos = 12, fmt = null, off = 0, len = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), sz = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { fmtCode: buf.readUInt16LE(pos + 8), ch: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    else if (id === 'data') { off = pos + 8; len = sz; }
    pos += 8 + sz + (sz % 2);
  }
  const n = fmt.bits === 16 ? len / 2 : len / 4;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = fmt.bits === 16 ? buf.readInt16LE(off + i * 2) / 32768 : (fmt.fmtCode === 3 ? buf.readFloatLE(off + i * 4) : buf.readInt32LE(off + i * 4) / 2147483648);
  let m = x;
  if (fmt.ch > 1) { m = new Float32Array(Math.floor(n / fmt.ch)); for (let i = 0; i < m.length; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += x[i * fmt.ch + c]; m[i] = s / fmt.ch; } }
  return { pcm: m, rate: fmt.rate };
}
function resample(p, from) {
  if (from === SR) return p;
  const r = from / SR, o = new Float32Array(Math.floor(p.length / r));
  for (let i = 0; i < o.length; i++) { const s = i * r, i0 = Math.floor(s), f = s - i0; o[i] = (p[i0] || 0) * (1 - f) + (p[i0 + 1] || 0) * f; }
  return o;
}
function biquad(sig, b0, b1, b2, a1, a2) { const out = new Float32Array(sig.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < sig.length; i++) { const x0 = sig[i]; const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0; } return out; }
function bandpass(pcm, hp, lp, q = 0.9) {
  const hw = 2 * Math.PI * hp / SR, ha = Math.sin(hw) / q, hc = Math.cos(hw);
  let a0 = 1 + ha;
  let s = biquad(pcm, (1 + hc) / 2 / a0, -(1 + hc) / a0, (1 + hc) / 2 / a0, -2 * hc / a0, (1 - ha) / a0);
  const lw = 2 * Math.PI * lp / SR, la = Math.sin(lw) / q, lc = Math.cos(lw);
  a0 = 1 + la;
  return biquad(s, (1 - lc) / 2 / a0, (1 - lc) / a0, (1 - lc) / 2 / a0, -2 * lc / a0, (1 - la) / a0);
}
function mulberry32(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function capture(pcm, { seed = 7, noise = 0.004, refl = 0.35, level = 0.7 } = {}) {
  const rnd = mulberry32(seed);
  let s = bandpass(pcm, 400, 4500, 0.9);
  const w = 2 * Math.PI * 1200 / SR, alpha = Math.sin(w) / (2 * 1.2), A = Math.pow(10, 6 / 40);
  const a0 = 1 + alpha / A;
  s = biquad(s, (1 + alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha / A) / a0);
  for (let i = 0; i < s.length; i++) s[i] = Math.tanh(s[i] * 3.0) / 3.0;
  const d1 = Math.floor(SR * 0.008);
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] + refl * (i > d1 ? s[i - d1] : 0);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * level + (rnd() * 2 - 1) * noise;
  return out;
}

// hydrate SHIPPED artifact through the SHIPPED code path
const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'constellation_v1.json'), 'utf8'));
const info = hydrateIndex(art);
console.log(`[review] shipped index: ${info.refs} refs, ${info.hashes} distinct hashes`);
// per-ref hash counts (for the corrected normalization)
const refHashCounts = new Array(art.refs.length).fill(0);
{
  const b64ToInt32 = (b64) => { const bin = Buffer.from(b64, 'base64'); return new Int32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4); };
  const vals = b64ToInt32(art.vals);
  for (let i = 0; i < vals.length; i++) refHashCounts[vals[i] >>> 20]++;
}
art.refs.forEach((r, i) => console.log(`  ref#${i} ${String(refHashCounts[i]).padStart(6)} hashes  ${r.source_file}`));

function q5(pcm) { return matchHashes(computeConstellationHashes(pcm)); }
function correctedNorm(m, fp) {
  if (!m.ref) return 0;
  const refIdx = art.refs.findIndex(r => r.source_file === m.ref.source_file);
  return m.score / Math.max(1, Math.min(fp.h.length, refHashCounts[refIdx]));
}

console.log('\n=== F1/F4: POSITIVES vs SHIPPED index (30cm sim, 5 s, looped play) ===');
console.log('query                         score  norm   corrNorm  2nd    best-ref');
const posRows = [];
for (const name of fs.readdirSync(SRC10).filter(f => f.toLowerCase().endsWith('.wav'))) {
  const { pcm, rate } = decodeWav(fs.readFileSync(path.join(SRC10, name)));
  const full = resample(pcm, rate);
  const start = Math.floor(full.length * 0.3);
  const q = capture(full.slice(start, start + SR * 5));
  const fp = computeConstellationHashes(q);
  const m = matchHashes(fp);
  const cn = correctedNorm(m, fp);
  posRows.push({ name, ...m, corrNorm: cn, refName: m.ref?.source_file });
  console.log(`  ${name.slice(0, 27).padEnd(29)} ${String(m.score).padStart(5)}  ${m.normalized.toFixed(3)}  ${cn.toFixed(3)}    ${String(m.secondScore).padStart(4)}  ${m.ref?.source_file === name ? 'SELF' : m.ref?.source_file}`);
}

console.log('\n=== F2/F3: SHORT PS VARIANTS — looped vs SINGLE play in 5 s window ===');
for (const name of art.refs.map(r => r.source_file).filter(n => /^Issue_with/.test(n))) {
  const buf = Buffer.from(await (await fetch(BUCKET + encodeURIComponent(name))).arrayBuffer());
  const { pcm, rate } = decodeWav(buf);
  const clip = resample(pcm, rate);
  // looped play (5 s continuous repetition)
  const loop = new Float32Array(SR * 5);
  for (let i = 0; i < loop.length; i++) loop[i] = clip[i % clip.length];
  // single play: clip once, then room noise
  const single = new Float32Array(SR * 5);
  const rnd = mulberry32(3);
  single.set(clip.subarray(0, Math.min(clip.length, single.length)));
  for (let i = clip.length; i < single.length; i++) single[i] = (rnd() * 2 - 1) * 0.003;
  for (const [tag, sig] of [['looped', loop], ['single', single]]) {
    const q = capture(sig);
    const fp = computeConstellationHashes(q);
    const m = matchHashes(fp);
    const cn = correctedNorm(m, fp);
    const pass = m.score >= 400 && m.normalized >= 0.05;
    const passCorr = m.score >= 400 && cn >= 0.05;
    console.log(`  ${name.slice(30, 60).padEnd(32)} ${tag.padEnd(7)} score=${String(m.score).padStart(5)} norm=${m.normalized.toFixed(3)} corr=${cn.toFixed(3)} best=${(m.ref?.source_file || '-').slice(30, 60)} | shipped:${pass ? 'PASS' : 'FAIL'} corrected:${passCorr ? 'PASS' : 'FAIL'}`);
  }
}

console.log('\n=== F1: NEGATIVES vs SHIPPED index (worst over sets) ===');
let worst = { score: 0, norm: 0, corr: 0, label: '' };
function track(label, m, fp) {
  const cn = correctedNorm(m, fp);
  if (m.score > worst.score) worst = { score: m.score, norm: m.normalized, corr: cn, label };
  return cn;
}
function synth(kind, sec = 5) {
  const n = SR * sec, out = new Float32Array(n), rnd = mulberry32(11);
  if (kind === 'white') { for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.08; }
  else if (kind === 'fan') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.995 * lp + 0.005 * (rnd() * 2 - 1); out[i] = lp * 6 + 0.004 * Math.sin(2 * Math.PI * 48 * i / SR); } }
  else if (kind === 'traffic') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.9985 * lp + 0.0015 * (rnd() * 2 - 1); out[i] = lp * 9 + 0.02 * Math.sin(2 * Math.PI * 90 * i / SR); } }
  else { const notes = [261.6, 329.6, 392.0, 523.3]; for (let i = 0; i < n; i++) { const t = i / SR, f = notes[Math.floor(t * 2) % 4]; out[i] = 0.16 * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t)); } }
  return out;
}
let negMaxCorr = 0;
for (const k of ['white', 'fan', 'traffic', 'music']) {
  for (const mk of [p => p, p => capture(p)]) {
    const fp = computeConstellationHashes(mk(synth(k)));
    const m = matchHashes(fp);
    negMaxCorr = Math.max(negMaxCorr, track(k, m, fp));
  }
}
for (const f of fs.readdirSync(TESTAUDIO).filter(x => /\.wav$/i.test(x))) {
  const d = decodeWav(fs.readFileSync(path.join(TESTAUDIO, f)));
  const p = resample(d.pcm, d.rate).slice(0, SR * 5);
  for (const mk of [x => x, x => capture(x)]) {
    const fp = computeConstellationHashes(mk(p));
    const m = matchHashes(fp);
    negMaxCorr = Math.max(negMaxCorr, track(f, m, fp));
  }
}
let hN = 0;
for (const [lbl, sub] of [['idle', path.join(DATASET, 'idle state', 'normal_engine_idle')],
                          ['startup', path.join(DATASET, 'startup state', 'normal_engine_startup')],
                          ['brakes', path.join(DATASET, 'braking state', 'normal_brakes')]]) {
  if (!fs.existsSync(sub)) continue;
  for (const f of fs.readdirSync(sub).filter(f => /\.wav$/i.test(f)).filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === 1; }).slice(0, 45)) {
    try {
      const d = decodeWav(fs.readFileSync(path.join(sub, f)));
      let p = resample(d.pcm, d.rate);
      if (p.length < SR * 5) { const o = new Float32Array(SR * 5); for (let i = 0; i < o.length; i++) o[i] = p[i % p.length]; p = o; }
      const fp = computeConstellationHashes(p.slice(0, SR * 5));
      const m = matchHashes(fp);
      negMaxCorr = Math.max(negMaxCorr, track(`healthy-${lbl}/${f}`, m, fp));
      hN++;
    } catch {}
  }
}
console.log(`  healthy clips tested: ${hN}`);
console.log(`  WORST negative: score=${worst.score} norm=${worst.norm.toFixed(3)} corrNorm=${worst.corr.toFixed(3)} (${worst.label})`);
console.log(`  max corrected-norm across ALL negatives: ${negMaxCorr.toFixed(3)}`);
const minPosCorr = Math.min(...posRows.map(r => r.corrNorm));
console.log(`\n  min positive corrNorm (10 s refs): ${minPosCorr.toFixed(3)} | corrected-norm headroom x${(minPosCorr / Math.max(negMaxCorr, 1e-6)).toFixed(1)}`);
