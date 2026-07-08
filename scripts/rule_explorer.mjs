// rule_explorer.mjs — evaluate candidate decision rules instantly on the
// per-window measurements dumped by benchmark_discrimination.mjs.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const measured = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scratch', 'bench_measurements.json'), 'utf8'));
const TAU = 0.60;

function evalRule(name, decideFn) {
  let hN = 0, hFP = 0, iN = 0, iFP = 0, fN = 0, fDet = 0, bN = 0, bDet = 0;
  const fpLabels = new Map();
  for (const { name: setName, kind, sessions } of measured) {
    for (const wins of sessions) {
      const anomalies = decideFn(wins.filter(Boolean));
      if (kind === 'neg') {
        if (setName.startsWith('interferers')) { iN++; if (anomalies.size) iFP++; }
        else {
          hN++;
          if (anomalies.size) { hFP++; for (const a of anomalies) fpLabels.set(a, (fpLabels.get(a) || 0) + 1); }
        }
      } else if (setName.startsWith('bucket')) { bN++; if (anomalies.size) bDet++; }
      else { fN++; if (anomalies.size) fDet++; }
    }
  }
  const fpStr = [...fpLabels.entries()].map(([l, c]) => `${l.slice(0, 24)}×${c}`).join(', ');
  console.log(`${name.padEnd(46)} healthyFP ${String(hFP).padStart(2)}/${hN}  intf ${iFP}/${iN}  fault ${String(fDet).padStart(2)}/${fN}  bucket ${bDet}/${bN}  ${fpStr ? 'FP→ ' + fpStr : ''}`);
}

// Rule builders (all require bf >= TAU per window)
const fixedMargin = (d) => (wins) => {
  const hits = new Map(), out = new Set();
  for (const w of wins) {
    if (w.bf >= TAU && w.margin >= d) {
      const h = (hits.get(w.bl) || 0) + 1;
      hits.set(w.bl, h);
      if (h >= 2 || w.bf >= 0.95) out.add(w.bl);
    }
  }
  return out;
};
const tiered = (dHi, dLo, kLo) => (wins) => {
  const hi = new Map(), lo = new Map(), out = new Set();
  for (const w of wins) {
    if (w.bf < TAU) continue;
    if (w.margin >= dHi) { const h = (hi.get(w.bl) || 0) + 1; hi.set(w.bl, h); if (h >= 2) out.add(w.bl); }
    if (w.margin >= dLo) { const h = (lo.get(w.bl) || 0) + 1; lo.set(w.bl, h); if (h >= kLo) out.add(w.bl); }
  }
  return out;
};
const fraction = (dLo, frac, minWin) => (wins) => {
  const per = new Map(), out = new Set();
  let accepted = 0;
  for (const w of wins) {
    accepted++;
    if (w.bf >= TAU && w.margin >= dLo) per.set(w.bl, (per.get(w.bl) || 0) + 1);
  }
  for (const [l, c] of per) if (accepted >= minWin && c / accepted >= frac) out.add(l);
  return out;
};
const meanMargin = (dMean, minHits, dFloor) => (wins) => {
  const agg = new Map(), out = new Set();
  for (const w of wins) {
    if (w.bf < TAU || w.margin < dFloor) continue;
    const a = agg.get(w.bl) || { sum: 0, n: 0 };
    a.sum += w.margin; a.n++;
    agg.set(w.bl, a);
  }
  for (const [l, a] of agg) if (a.n >= minHits && a.sum / a.n >= dMean) out.add(l);
  return out;
};

console.log('── fixed margin (baseline) ──');
for (const d of [0.05, 0.08, 0.10, 0.12, 0.15]) evalRule(`fixed δ=${d}`, fixedMargin(d));
console.log('── tiered: 2 strong hits OR k weak hits ──');
for (const [hi, lo, k] of [[0.12, 0.05, 5], [0.12, 0.05, 6], [0.12, 0.06, 5], [0.15, 0.06, 6], [0.12, 0.08, 4], [0.15, 0.08, 5], [0.10, 0.05, 6]]) {
  evalRule(`tiered hi=${hi} lo=${lo} k=${k}`, tiered(hi, lo, k));
}
console.log('── fraction of windows ≥ δlo ──');
for (const [d, f] of [[0.05, 0.5], [0.05, 0.6], [0.06, 0.5], [0.08, 0.4], [0.08, 0.5]]) {
  evalRule(`fraction δ=${d} f=${f}`, fraction(d, f, 4));
}
console.log('── mean margin over hits ──');
for (const [dm, n, df] of [[0.08, 3, 0.02], [0.10, 3, 0.02], [0.10, 4, 0.03], [0.12, 3, 0.03], [0.08, 4, 0.0]]) {
  evalRule(`mean≥${dm} hits≥${n} floor=${df}`, meanMargin(dm, n, df));
}
