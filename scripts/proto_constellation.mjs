/**
 * proto_constellation.mjs — decisive experiment for Shazam-style matching.
 *
 * Question: can spectral-peak constellation hashing identify a reference
 * recording replayed through a speaker, within <= 5 s, while staying silent on
 * speech / music / noise / healthy engines?
 *
 * Algorithm (Shazam, Wang 2003):
 *   spectrogram -> per-band local maxima ("constellation") -> anchor/target
 *   pairs hashed as (f1, df, dt) -> match by TIME-OFFSET COHERENCE. A true
 *   match spikes at ONE offset; unrelated audio scatters uniformly. That
 *   coherence requirement is what buys sensitivity without false positives.
 *
 * MEASURE ONLY — writes nothing into the app.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC10 = path.resolve(ROOT, '..', 'audio_files', 'extended_10s');
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const TESTAUDIO = path.join(ROOT, 'scratch', 'testaudio');

const SR = 16000;
// 1024-pt FFT @16k = 64 ms window, 31.25 Hz/bin; hop 256 = 16 ms.
const NFFT = 1024, HOP = 256, NBINS = NFFT / 2;
const BANDS = [0, 20, 40, 80, 160, 320, NBINS];   // ~log-spaced bin edges
const PEAK_FACTOR = 1.6;      // peak must exceed band mean by this factor
const FANOUT = 6;             // targets paired per anchor
const DT_MIN = 1, DT_MAX = 48;
const DF_MAX = 160;

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
  for (let i = 0; i < n; i++) {
    x[i] = fmt.bits === 16 ? buf.readInt16LE(off + i * 2) / 32768
         : (fmt.fmtCode === 3 ? buf.readFloatLE(off + i * 4) : buf.readInt32LE(off + i * 4) / 2147483648);
  }
  let m = x;
  if (fmt.ch > 1) {
    m = new Float32Array(Math.floor(n / fmt.ch));
    for (let i = 0; i < m.length; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += x[i * fmt.ch + c]; m[i] = s / fmt.ch; }
  }
  return { pcm: m, rate: fmt.rate };
}
function resample(p, from) {
  if (from === SR) return p;
  const r = from / SR, o = new Float32Array(Math.floor(p.length / r));
  for (let i = 0; i < o.length; i++) { const s = i * r, i0 = Math.floor(s), f = s - i0; o[i] = (p[i0] || 0) * (1 - f) + (p[i0 + 1] || 0) * f; }
  return o;
}
const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };

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
const HANN = (() => { const w = new Float64Array(NFFT); for (let i = 0; i < NFFT; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (NFFT - 1)); return w; })();

/** Constellation: per frame, the strongest bin in each band if it stands above the band mean. */
function constellation(pcm) {
  const peaks = [];   // {t, f}
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
      const mean = sum / (hi - lo);
      if (best > mean * PEAK_FACTOR && best > 1e-6) peaks.push({ t, f: bestI });
    }
  }
  return peaks;
}

/** Pack (f1, df, dt) into one integer key. */
const packHash = (f1, df, dt) => ((f1 & 0x1ff) << 15) | (((df + 256) & 0x1ff) << 6) | (dt & 0x3f);

function hashes(peaks) {
  const out = [];
  for (let i = 0; i < peaks.length; i++) {
    const a = peaks[i];
    let paired = 0;
    for (let j = i + 1; j < peaks.length && paired < FANOUT; j++) {
      const b = peaks[j];
      const dt = b.t - a.t;
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

// ── channel sims (identical to the validated RCA sims) ──────────────────────
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
function phoneSpeakerSim(pcm, seed = 7, noiseAmp = 0.002) {
  const rnd = mulberry32(seed);
  let s = bandpass(pcm, 400, 4500, 0.9);
  const w = 2 * Math.PI * 1200 / SR, alpha = Math.sin(w) / (2 * 1.2), A = Math.pow(10, 6 / 40);
  const a0 = 1 + alpha / A;
  s = biquad(s, (1 + alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha / A) / a0);
  for (let i = 0; i < s.length; i++) s[i] = Math.tanh(s[i] * 3.0) / 3.0;
  const d1 = Math.floor(SR * 0.008);
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] + 0.35 * (i > d1 ? s[i - d1] : 0);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * 0.6 + (rnd() * 2 - 1) * noiseAmp;
  return out;
}

// ── build index from the extended 10 s references ───────────────────────────
console.log('[proto] indexing extended 10 s references...');
const index = new Map();     // hash -> [{id, t}]
const refNames = [];
for (const name of fs.readdirSync(SRC10).filter(f => f.toLowerCase().endsWith('.wav'))) {
  const { pcm, rate } = decodeWav(fs.readFileSync(path.join(SRC10, name)));
  const p = resample(pcm, rate);
  const id = refNames.length;
  refNames.push(name);
  const hs = hashes(constellation(p));
  for (const { h, t } of hs) {
    let arr = index.get(h);
    if (!arr) { arr = []; index.set(h, arr); }
    arr.push({ id, t });
  }
  console.log(`  ${name.padEnd(28)} peaks->hashes: ${hs.length}`);
}
console.log(`[proto] index: ${index.size} distinct hashes over ${refNames.length} references`);

/** Query: returns best {name, score, offset} by time-offset coherence. */
function query(pcm) {
  const qh = hashes(constellation(pcm));
  const votes = new Map();   // id -> Map(offset -> count)
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
  let best = { name: null, score: 0, offset: 0, total: qh.length };
  for (const [id, m] of votes) {
    for (const [off, c] of m) {
      if (c > best.score) best = { name: refNames[id], score: c, offset: off, total: qh.length };
    }
  }
  return best;
}

const DURATIONS = [3, 5];
console.log('\n=== POSITIVES: reference replayed through phone-speaker sim ===');
console.log('file                          dur  seed  score  identified');
const posScores = [];
for (const name of refNames) {
  const { pcm, rate } = decodeWav(fs.readFileSync(path.join(SRC10, name)));
  const full = resample(pcm, rate);
  for (const secs of DURATIONS) {
    for (const seed of [7, 33]) {
      // take a mid excerpt so query and reference are NOT aligned at offset 0
      const start = Math.floor(full.length * 0.3);
      const excerpt = full.slice(start, start + SR * secs);
      const q = phoneSpeakerSim(excerpt, seed);
      const r = query(q);
      const ok = r.name === name;
      posScores.push({ name, secs, score: r.score, ok });
      console.log(`  ${name.slice(0, 26).padEnd(27)} ${secs}s  ${String(seed).padEnd(4)} ${String(r.score).padStart(5)}  ${r.name || '-'}${ok ? ' OK' : ' MISMATCH'}`);
    }
  }
}

console.log('\n=== NEGATIVES: must produce near-zero coherent score ===');
const negScores = [];
function synth(kind, sec = 5) {
  const n = SR * sec, out = new Float32Array(n), rnd = mulberry32(11);
  if (kind === 'white') { for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.08; }
  else if (kind === 'fan') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.995 * lp + 0.005 * (rnd() * 2 - 1); out[i] = lp * 6 + 0.004 * Math.sin(2 * Math.PI * 48 * i / SR); } }
  else if (kind === 'traffic') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.9985 * lp + 0.0015 * (rnd() * 2 - 1); out[i] = lp * 9 + 0.02 * Math.sin(2 * Math.PI * 90 * i / SR); } }
  else { const notes = [261.6, 329.6, 392.0, 523.3]; for (let i = 0; i < n; i++) { const t = i / SR, f = notes[Math.floor(t * 2) % 4]; out[i] = 0.16 * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t)); } }
  return out;
}
for (const k of ['white', 'fan', 'traffic', 'music']) {
  const r = query(synth(k));
  negScores.push({ label: k, score: r.score });
  console.log(`  ${k.padEnd(28)} score=${String(r.score).padStart(4)}  best=${r.name || '-'}`);
}
if (fs.existsSync(TESTAUDIO)) {
  for (const f of fs.readdirSync(TESTAUDIO).filter(x => /\.wav$/i.test(x))) {
    const d = decodeWav(fs.readFileSync(path.join(TESTAUDIO, f)));
    const p = resample(d.pcm, d.rate).slice(0, SR * 5);
    for (const [tag, q] of [['direct', p], ['spk', phoneSpeakerSim(p)]]) {
      const r = query(q);
      negScores.push({ label: `${f}:${tag}`, score: r.score });
      console.log(`  ${(f + ':' + tag).padEnd(28)} score=${String(r.score).padStart(4)}  best=${r.name || '-'}`);
    }
  }
}
// healthy engines — the most important negatives
let healthyMax = 0, healthyN = 0;
for (const [lbl, sub] of [['idle', path.join(DATASET, 'idle state', 'normal_engine_idle')],
                          ['startup', path.join(DATASET, 'startup state', 'normal_engine_startup')],
                          ['brakes', path.join(DATASET, 'braking state', 'normal_brakes')]]) {
  if (!fs.existsSync(sub)) continue;
  const files = fs.readdirSync(sub).filter(f => /\.wav$/i.test(f))
    .filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === 1; }).slice(0, 40);
  for (const f of files) {
    try {
      const d = decodeWav(fs.readFileSync(path.join(sub, f)));
      let p = resample(d.pcm, d.rate);
      if (p.length < SR * 5) { const o = new Float32Array(SR * 5); for (let i = 0; i < o.length; i++) o[i] = p[i % p.length]; p = o; }
      const r = query(p.slice(0, SR * 5));
      healthyN++;
      if (r.score > healthyMax) healthyMax = r.score;
      negScores.push({ label: `healthy-${lbl}/${f}`, score: r.score });
    } catch {}
  }
}
console.log(`  healthy engines (${healthyN} clips)   max score=${healthyMax}`);

const posMin5 = Math.min(...posScores.filter(p => p.secs === 5).map(p => p.score));
const posMin3 = Math.min(...posScores.filter(p => p.secs === 3).map(p => p.score));
const negMax = Math.max(...negScores.map(n => n.score));
console.log('\n=== SEPARATION ===');
console.log(`  min positive score @5s: ${posMin5}`);
console.log(`  min positive score @3s: ${posMin3}`);
console.log(`  MAX negative score    : ${negMax}`);
console.log(`  positives correctly identified: ${posScores.filter(p => p.ok).length}/${posScores.length}`);
console.log(negMax < posMin5 ? `  >>> CLEAN SEPARATION — safe threshold band ${negMax + 1}..${posMin5}` : '  >>> NO CLEAN SEPARATION at these settings');
fs.writeFileSync(path.join(ROOT, 'scratch', 'proto_constellation.json'), JSON.stringify({ posScores, negScores, posMin5, posMin3, negMax }, null, 1));
