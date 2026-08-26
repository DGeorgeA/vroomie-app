/**
 * proto_constellation_sensitivity.mjs — how far do constellation scores fall
 * under progressively harsher capture, and where is a threshold safe?
 *
 * Sweeps distance/noise/level for positives and reports scores NORMALIZED by
 * query-hash count, so one threshold works regardless of listen duration.
 * Re-measures the full negative set the same way. MEASURE ONLY.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC10 = path.resolve(ROOT, '..', 'audio_files', 'extended_10s');
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const TESTAUDIO = path.join(ROOT, 'scratch', 'testaudio');

const SR = 16000, NFFT = 1024, HOP = 256, NBINS = NFFT / 2;
const BANDS = [0, 20, 40, 80, 160, 320, NBINS];
const PEAK_FACTOR = 1.6, FANOUT = 6, DT_MIN = 1, DT_MAX = 48, DF_MAX = 160;

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
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
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
const HANN = (() => { const w = new Float64Array(NFFT); for (let i = 0; i < NFFT; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (NFFT - 1)); return w; })();
function constellation(pcm) {
  const peaks = [];
  const frames = Math.floor((pcm.length - NFFT) / HOP) + 1;
  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
    for (let i = 0; i < NFFT; i++) re[i] = pcm[off + i] * HANN[i];
    fft(re, im);
    const mag = new Float64Array(NBINS);
    for (let i = 0; i < NBINS; i++) mag[i] = Math.hypot(re[i], im[i]);
    for (let b = 0; b < BANDS.length - 1; b++) {
      const lo = BANDS[b], hi = BANDS[b + 1];
      let best = -1, bestI = -1, sum = 0;
      for (let i = lo; i < hi; i++) { sum += mag[i]; if (mag[i] > best) { best = mag[i]; bestI = i; } }
      if (best > (sum / (hi - lo)) * PEAK_FACTOR && best > 1e-6) peaks.push({ t, f: bestI });
    }
  }
  return peaks;
}
const packHash = (f1, df, dt) => ((f1 & 0x1ff) << 15) | (((df + 256) & 0x1ff) << 6) | (dt & 0x3f);
function hashes(peaks) {
  const out = [];
  for (let i = 0; i < peaks.length; i++) {
    const a = peaks[i];
    let paired = 0;
    for (let j = i + 1; j < peaks.length && paired < FANOUT; j++) {
      const b = peaks[j], dt = b.t - a.t;
      if (dt < DT_MIN) continue;
      if (dt > DT_MAX) break;
      const df = b.f - a.f;
      if (Math.abs(df) > DF_MAX) continue;
      out.push({ h: packHash(a.f, df, dt), t: a.t });
      paired++;
    }
  }
  return out;
}
function biquad(sig, b0, b1, b2, a1, a2) { const out = new Float32Array(sig.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < sig.length; i++) { const x0 = sig[i]; const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0; } return out; }
function bandpass(pcm, hp, lp, q = 1.4) {
  const hw = 2 * Math.PI * hp / SR, ha = Math.sin(hw) / q, hc = Math.cos(hw);
  let a0 = 1 + ha;
  let s = biquad(pcm, (1 + hc) / 2 / a0, -(1 + hc) / a0, (1 + hc) / 2 / a0, -2 * hc / a0, (1 - ha) / a0);
  const lw = 2 * Math.PI * lp / SR, la = Math.sin(lw) / q, lc = Math.cos(lw);
  a0 = 1 + la;
  return biquad(s, (1 - lc) / 2 / a0, (1 - lc) / a0, (1 - lc) / 2 / a0, -2 * lc / a0, (1 - la) / a0);
}
function mulberry32(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
/** Harsh capture: band limit + resonance + compression + reverb tail + noise + level. */
function capture(pcm, { seed = 7, noise = 0.002, refl = 0.35, level = 1.0, band = [400, 4500] } = {}) {
  const rnd = mulberry32(seed);
  let s = bandpass(pcm, band[0], band[1], 0.9);
  const w = 2 * Math.PI * 1200 / SR, alpha = Math.sin(w) / (2 * 1.2), A = Math.pow(10, 6 / 40);
  const a0 = 1 + alpha / A;
  s = biquad(s, (1 + alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha / A) / a0);
  for (let i = 0; i < s.length; i++) s[i] = Math.tanh(s[i] * 3.0) / 3.0;
  const d1 = Math.floor(SR * 0.008), d2 = Math.floor(SR * 0.021);
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] + refl * (i > d1 ? s[i - d1] : 0) + refl * 0.5 * (i > d2 ? s[i - d2] : 0);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * level + (rnd() * 2 - 1) * noise;
  return out;
}

const index = new Map();
const refNames = [];
for (const name of fs.readdirSync(SRC10).filter(f => f.toLowerCase().endsWith('.wav'))) {
  const { pcm, rate } = decodeWav(fs.readFileSync(path.join(SRC10, name)));
  const id = refNames.length;
  refNames.push(name);
  for (const { h, t } of hashes(constellation(resample(pcm, rate)))) {
    let arr = index.get(h);
    if (!arr) { arr = []; index.set(h, arr); }
    arr.push({ id, t });
  }
}
function query(pcm) {
  const qh = hashes(constellation(pcm));
  const votes = new Map();
  for (const { h, t } of qh) {
    const hits = index.get(h);
    if (!hits) continue;
    for (const { id, t: rt } of hits) {
      let m = votes.get(id);
      if (!m) { m = new Map(); votes.set(id, m); }
      const off = rt - t;
      m.set(off, (m.get(off) || 0) + 1);
    }
  }
  let best = { name: null, score: 0 }, second = 0;
  for (const [id, m] of votes) {
    let localBest = 0;
    for (const [, c] of m) if (c > localBest) localBest = c;
    if (localBest > best.score) { second = best.score; best = { name: refNames[id], score: localBest }; }
    else if (localBest > second) second = localBest;
  }
  const total = Math.max(qh.length, 1);
  return { name: best.name, score: best.score, second, norm: best.score / total, total: qh.length };
}

const CONDITIONS = [
  ['close/clean   ', { noise: 0.002, refl: 0.30, level: 1.00 }],
  ['30cm typical  ', { noise: 0.004, refl: 0.35, level: 0.70 }],
  ['50cm noisy    ', { noise: 0.010, refl: 0.45, level: 0.45 }],
  ['1m reverberant', { noise: 0.018, refl: 0.60, level: 0.30 }],
  ['tiny speaker  ', { noise: 0.008, refl: 0.40, level: 0.50, band: [600, 3500] }],
];
console.log('=== POSITIVE SENSITIVITY (5 s listen) — raw score / normalized ===');
console.log('condition        ' + refNames.map(n => n.slice(0, 9).padEnd(10)).join(''));
const posNorms = [];
for (const [label, opts] of CONDITIONS) {
  const row = [];
  for (const name of refNames) {
    const { pcm, rate } = decodeWav(fs.readFileSync(path.join(SRC10, name)));
    const full = resample(pcm, rate);
    const start = Math.floor(full.length * 0.3);
    const q = capture(full.slice(start, start + SR * 5), opts);
    const r = query(q);
    const ok = r.name === name;
    posNorms.push({ label, name, score: r.score, norm: r.norm, ok });
    row.push(`${ok ? '' : 'X'}${r.score}/${r.norm.toFixed(2)}`.padEnd(10));
  }
  console.log(label + ' ' + row.join(''));
}
console.log('\n=== 3 s listen (early fire) ===');
for (const [label, opts] of [CONDITIONS[1], CONDITIONS[3]]) {
  const row = [];
  for (const name of refNames) {
    const { pcm, rate } = decodeWav(fs.readFileSync(path.join(SRC10, name)));
    const full = resample(pcm, rate);
    const start = Math.floor(full.length * 0.3);
    const r = query(capture(full.slice(start, start + SR * 3), opts));
    const ok = r.name === name;
    posNorms.push({ label: label + '@3s', name, score: r.score, norm: r.norm, ok });
    row.push(`${ok ? '' : 'X'}${r.score}/${r.norm.toFixed(2)}`.padEnd(10));
  }
  console.log(label + '@3s ' + row.join(''));
}

console.log('\n=== NEGATIVES (5 s) ===');
const negNorms = [];
function synth(kind, sec = 5) {
  const n = SR * sec, out = new Float32Array(n), rnd = mulberry32(11);
  if (kind === 'white') { for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.08; }
  else if (kind === 'fan') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.995 * lp + 0.005 * (rnd() * 2 - 1); out[i] = lp * 6 + 0.004 * Math.sin(2 * Math.PI * 48 * i / SR); } }
  else if (kind === 'traffic') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.9985 * lp + 0.0015 * (rnd() * 2 - 1); out[i] = lp * 9 + 0.02 * Math.sin(2 * Math.PI * 90 * i / SR); } }
  else { const notes = [261.6, 329.6, 392.0, 523.3]; for (let i = 0; i < n; i++) { const t = i / SR, f = notes[Math.floor(t * 2) % 4]; out[i] = 0.16 * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t)); } }
  return out;
}
for (const k of ['white', 'fan', 'traffic', 'music']) {
  for (const [tag, mk] of [['direct', p => p], ['spk', p => capture(p, { noise: 0.004 })]]) {
    const r = query(mk(synth(k)));
    negNorms.push({ label: `${k}:${tag}`, score: r.score, norm: r.norm });
    console.log(`  ${(k + ':' + tag).padEnd(24)} score=${String(r.score).padStart(4)} norm=${r.norm.toFixed(3)}`);
  }
}
if (fs.existsSync(TESTAUDIO)) {
  for (const f of fs.readdirSync(TESTAUDIO).filter(x => /\.wav$/i.test(x))) {
    const d = decodeWav(fs.readFileSync(path.join(TESTAUDIO, f)));
    const p = resample(d.pcm, d.rate).slice(0, SR * 5);
    for (const [tag, q] of [['direct', p], ['spk', capture(p, { noise: 0.004 })]]) {
      const r = query(q);
      negNorms.push({ label: `${f}:${tag}`, score: r.score, norm: r.norm });
      console.log(`  ${(f.slice(0, 18) + ':' + tag).padEnd(24)} score=${String(r.score).padStart(4)} norm=${r.norm.toFixed(3)}`);
    }
  }
}
let hMaxScore = 0, hMaxNorm = 0, hN = 0, hWorst = '';
for (const [lbl, sub] of [['idle', path.join(DATASET, 'idle state', 'normal_engine_idle')],
                          ['startup', path.join(DATASET, 'startup state', 'normal_engine_startup')],
                          ['brakes', path.join(DATASET, 'braking state', 'normal_brakes')]]) {
  if (!fs.existsSync(sub)) continue;
  for (const f of fs.readdirSync(sub).filter(f => /\.wav$/i.test(f)).filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === 1; }).slice(0, 45)) {
    try {
      const d = decodeWav(fs.readFileSync(path.join(sub, f)));
      let p = resample(d.pcm, d.rate);
      if (p.length < SR * 5) { const o = new Float32Array(SR * 5); for (let i = 0; i < o.length; i++) o[i] = p[i % p.length]; p = o; }
      const r = query(p.slice(0, SR * 5));
      hN++;
      negNorms.push({ label: `healthy-${lbl}/${f}`, score: r.score, norm: r.norm });
      if (r.score > hMaxScore) { hMaxScore = r.score; hWorst = `${lbl}/${f}`; }
      if (r.norm > hMaxNorm) hMaxNorm = r.norm;
    } catch {}
  }
}
console.log(`  healthy engines (${hN})       maxScore=${hMaxScore} maxNorm=${hMaxNorm.toFixed(3)}  worst=${hWorst}`);

const posOK = posNorms.filter(p => p.ok);
const minPosScore = Math.min(...posOK.map(p => p.score));
const minPosNorm = Math.min(...posOK.map(p => p.norm));
const maxNegScore = Math.max(...negNorms.map(n => n.score));
const maxNegNorm = Math.max(...negNorms.map(n => n.norm));
console.log('\n=== SEPARATION ACROSS ALL CONDITIONS ===');
console.log(`  positives identified : ${posOK.length}/${posNorms.length}`);
console.log(`  min positive  score=${minPosScore}  norm=${minPosNorm.toFixed(3)}`);
console.log(`  MAX negative  score=${maxNegScore}  norm=${maxNegNorm.toFixed(3)}`);
console.log(`  score headroom x${(minPosScore / Math.max(maxNegScore, 1)).toFixed(2)} | norm headroom x${(minPosNorm / Math.max(maxNegNorm, 1e-6)).toFixed(2)}`);
const failures = posNorms.filter(p => !p.ok);
if (failures.length) console.log('  MISIDENTIFIED:', failures.map(f => `${f.name}@${f.label}`).join(', '));
fs.writeFileSync(path.join(ROOT, 'scratch', 'proto_constellation_sensitivity.json'), JSON.stringify({ posNorms, negNorms, minPosScore, minPosNorm, maxNegScore, maxNegNorm }, null, 1));
