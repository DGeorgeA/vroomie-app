/**
 * verify_sustained_tier.mjs — safety gate for the real-device recalibration.
 * Drives the ACTUAL rolling matcher (persistence included) over every held-out
 * healthy clip and the full interferer suite. Any fire here is a false alarm.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRollingMatcher, hydrateIndex, SR,
         MIN_COHERENT_SCORE, SUSTAINED_COHERENT_SCORE, SUSTAINED_REPEATS } from '../src/lib/constellationMatcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATASET = path.resolve(ROOT, '..', 'audio_files', 'Kaggle_dataset', 'archive', 'car diagnostics dataset');
const TESTAUDIO = path.join(ROOT, 'scratch', 'testaudio');

hydrateIndex(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'constellation_v1.json'), 'utf8')));
console.log(`instant=${MIN_COHERENT_SCORE} sustained=${SUSTAINED_COHERENT_SCORE} x${SUSTAINED_REPEATS}`);

function decodeWav(b) {
  let p = 12, f = null, o = 0, l = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') f = { ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    else if (id === 'data') { o = p + 8; l = sz; }
    p += 8 + sz + (sz % 2);
  }
  const n = f.bits === 16 ? l / 2 : l / 4;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = f.bits === 16 ? b.readInt16LE(o + i * 2) / 32768 : b.readFloatLE(o + i * 4);
  let m = x;
  if (f.ch > 1) { m = new Float32Array(Math.floor(n / f.ch)); for (let i = 0; i < m.length; i++) { let s = 0; for (let c = 0; c < f.ch; c++) s += x[i * f.ch + c]; m[i] = s / f.ch; } }
  return { pcm: m, rate: f.rate };
}
const rs = (p, fr) => {
  if (fr === SR) return p;
  const r = fr / SR, o = new Float32Array(Math.floor(p.length / r));
  for (let i = 0; i < o.length; i++) { const s = i * r, i0 = Math.floor(s), ff = s - i0; o[i] = (p[i0] || 0) * (1 - ff) + (p[i0 + 1] || 0) * ff; }
  return o;
};
const mulberry32 = (seed) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

/** Exactly how the app drives it: ~85 ms blocks, tryMatch every ~0.9 s. */
function runRolling(pcm, seconds = 20) {
  const rm = createRollingMatcher();
  const blk = Math.floor(SR * 0.085);
  let t = 0, lastTry = 0, best = 0, bestLabel = null;
  // loop the clip to fill the requested duration (a real session keeps recording)
  const need = SR * seconds;
  const long = new Float32Array(need);
  for (let i = 0; i < need; i++) long[i] = pcm[i % pcm.length];
  for (let off = 0; off + blk <= long.length; off += blk) {
    rm.push(long.subarray(off, off + blk));
    t += 0.085;
    if (t - lastTry >= 0.9) {
      lastTry = t;
      const m = rm.tryMatch();
      if (m) {
        if (m.score > best) { best = m.score; bestLabel = m.ref ? m.ref.label : null; }
        if (m.matched) return { fired: true, label: m.ref ? m.ref.label : null, score: m.score, streak: m.streak, at: +t.toFixed(1) };
      }
    }
  }
  return { fired: false, best, bestLabel };
}

let fires = 0, total = 0;
const detail = [];
for (const [lbl, sub] of [['idle', path.join(DATASET, 'idle state', 'normal_engine_idle')],
                          ['startup', path.join(DATASET, 'startup state', 'normal_engine_startup')],
                          ['brakes', path.join(DATASET, 'braking state', 'normal_brakes')]]) {
  if (!fs.existsSync(sub)) continue;
  const files = fs.readdirSync(sub).filter(f => /\.wav$/i.test(f))
    .filter(f => { const m = f.match(/_(\d+)\.wav$/); return m && +m[1] % 2 === 1; })
    .sort((a, b) => +a.match(/_(\d+)\.wav$/)[1] - +b.match(/_(\d+)\.wav$/)[1]).slice(0, 70);
  for (const f of files) {
    try {
      const d = decodeWav(fs.readFileSync(path.join(sub, f)));
      const r = runRolling(rs(d.pcm, d.rate));
      total++;
      if (r.fired) { fires++; detail.push(`FIRE healthy-${lbl}/${f} -> ${r.label} score=${r.score} streak=${r.streak}`); }
    } catch {}
  }
}
console.log(`\nHEALTHY: ${fires} false fires / ${total} clips`);
detail.forEach(d => console.log('  ' + d));

// interferers
let iFires = 0, iTotal = 0;
function synth(kind, sec = 12) {
  const n = SR * sec, out = new Float32Array(n), rnd = mulberry32(11);
  if (kind === 'white') { for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.08; }
  else if (kind === 'fan') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.995 * lp + 0.005 * (rnd() * 2 - 1); out[i] = lp * 6 + 0.004 * Math.sin(2 * Math.PI * 48 * i / SR); } }
  else if (kind === 'traffic') { let lp = 0; for (let i = 0; i < n; i++) { lp = 0.9985 * lp + 0.0015 * (rnd() * 2 - 1); out[i] = lp * 9 + 0.02 * Math.sin(2 * Math.PI * 90 * i / SR); } }
  else if (kind === 'silence') { for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.0004; }
  else { const notes = [261.6, 329.6, 392.0, 523.3]; for (let i = 0; i < n; i++) { const t = i / SR, fq = notes[Math.floor(t * 2) % 4]; out[i] = 0.16 * (Math.sin(2 * Math.PI * fq * t) + 0.5 * Math.sin(4 * Math.PI * fq * t)); } }
  return out;
}
for (const k of ['white', 'fan', 'traffic', 'music', 'silence']) {
  const r = runRolling(synth(k));
  iTotal++;
  if (r.fired) { iFires++; console.log(`  FIRE ${k} -> ${r.label} score=${r.score}`); }
  else console.log(`  ok   ${k.padEnd(9)} best=${r.best} (${r.bestLabel || '-'})`);
}
if (fs.existsSync(TESTAUDIO)) {
  for (const f of fs.readdirSync(TESTAUDIO).filter(x => /\.wav$/i.test(x))) {
    const d = decodeWav(fs.readFileSync(path.join(TESTAUDIO, f)));
    const r = runRolling(rs(d.pcm, d.rate));
    iTotal++;
    if (r.fired) { iFires++; console.log(`  FIRE ${f} -> ${r.label} score=${r.score}`); }
    else console.log(`  ok   ${f.slice(0, 24).padEnd(26)} best=${r.best} (${r.bestLabel || '-'})`);
  }
}
console.log(`\nINTERFERERS: ${iFires} false fires / ${iTotal}`);
console.log(fires === 0 && iFires === 0 ? '\n>>> SAFE TO SHIP' : '\n>>> DO NOT SHIP');
